import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCatalogue, type Offer, type Snapshot } from "./catalogue.js";
import { plan, resolve as resolveModel, validateTokens, MAX_ROWS, MAX_TOKENS } from "./plan.js";
import { priceJob, costOf, money, usd } from "./pricing.js";
import { TOOLS } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SLUG = "sumplus-model-desk";

/**
 * The commit this build was cut from. It is injected at deploy time and
 * reported by /health and the verification document, which is how a reviewer
 * ties a running service to a line of source.
 */
const COMMIT = (process.env.REVIEW_COMMIT ?? "").trim();

/** The catalogue as it stood when this build was submitted. */
const SUBMITTED: Snapshot = JSON.parse(
  readFileSync(join(HERE, "..", "snapshots", "catalogue.json"), "utf8"),
) as Snapshot;

const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 60);
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): { limited: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + 60_000 };
    hits.set(ip, fresh);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    return { limited: false, remaining: RATE_LIMIT - 1, resetAt: fresh.resetAt };
  }
  entry.count += 1;
  return {
    limited: entry.count > RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - entry.count),
    resetAt: entry.resetAt,
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...headers,
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error("request body is too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function publicOffer(o: Offer) {
  return {
    modelId: o.modelId,
    name: o.name,
    line: o.line,
    lineCode: o.lineCode,
    ownedBy: o.ownedBy,
    context: o.context,
    maxOutput: o.maxOutput,
    availability: o.availability,
    inputPerMillion: usd(o.inputPerMillionMicro),
    outputPerMillion: usd(o.outputPerMillionMicro),
    cacheHitPerMillion: o.cacheHitPerMillionMicro === null ? null : usd(o.cacheHitPerMillionMicro),
  };
}

/** What changed between the catalogue submitted with this build and today's. */
function diffAgainstSubmitted(now: Snapshot) {
  const key = (o: Offer) => `${o.modelId}::${o.line}`;
  const before = new Map(SUBMITTED.offers.map((o) => [key(o), o]));
  const after = new Map(now.offers.map((o) => [key(o), o]));

  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const repriced: unknown[] = [];
  const rewindowed: unknown[] = [];

  for (const [k, a] of after) {
    const b = before.get(k);
    if (!b) continue;
    if (
      a.inputPerMillionMicro !== b.inputPerMillionMicro ||
      a.outputPerMillionMicro !== b.outputPerMillionMicro
    ) {
      repriced.push({
        offer: k,
        inputPerMillion: { was: usd(b.inputPerMillionMicro), now: usd(a.inputPerMillionMicro) },
        outputPerMillion: { was: usd(b.outputPerMillionMicro), now: usd(a.outputPerMillionMicro) },
      });
    }
    if (a.context !== b.context || a.maxOutput !== b.maxOutput) {
      rewindowed.push({
        offer: k,
        context: { was: b.context, now: a.context },
        maxOutput: { was: b.maxOutput, now: a.maxOutput },
      });
    }
  }

  return {
    submittedSnapshotId: SUBMITTED.snapshotId,
    submittedPricedAt: SUBMITTED.pricedAt,
    currentSnapshotId: now.snapshotId,
    currentPricedAt: now.pricedAt,
    identical: now.snapshotId === SUBMITTED.snapshotId,
    counts: {
      submitted: SUBMITTED.offers.length,
      current: now.offers.length,
      added: added.length,
      removed: removed.length,
      repriced: repriced.length,
      rewindowed: rewindowed.length,
    },
    added,
    removed,
    repriced,
    rewindowed,
    // Said plainly, because the opposite claim would be false: two readings of
    // one source agreeing proves the source moved, not that it is correct.
    whatThisShows:
      "The upstream catalogue is live and changes over time. It does not independently confirm that any price is correct.",
  };
}

const INDEX = {
  service: "Sumplus Model Desk",
  what:
    "Prices one job against every offer in a live model catalogue, and says which offers can actually take it.",
  why:
    "A model id is not a price. The same id is sold on several lines at different prices, and an offer whose context or output ceiling is too small does not refuse the job, it truncates the answer and bills for it.",
  endpoints: [
    "GET  /health",
    "GET  /.well-known/xagent-verification.json",
    "GET  /v1/tools.json",
    "POST /v1/plan_call",
    "POST /v1/quote",
    "GET  /v1/resolve?modelId=gpt-5.5",
    "GET  /v1/catalogue",
    "GET  /v1/catalogue/diff",
  ],
  sideEffects: "None. Every endpoint is read-only, needs no credentials, and costs the caller nothing.",
  scope:
    "Procurement and pricing for model calls. It does not inspect wallets, transactions, contracts, or security posture.",
};

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

  if (req.method === "OPTIONS") {
    return send(res, 204, null, { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" });
  }

  // The verification document and health are never rate limited: a reviewer
  // checking whether the service is alive must not be turned away.
  if (path === "/.well-known/xagent-verification.json") {
    return send(res, 200, { schemaVersion: 1, slug: SLUG, commit: COMMIT });
  }

  if (path === "/health") {
    const state = await ensureCatalogue();
    return send(
      res,
      200,
      {
        status: "ok",
        commit: COMMIT,
        slug: SLUG,
        catalogue: {
          snapshotId: state.snapshot?.snapshotId ?? null,
          pricedAt: state.snapshot?.pricedAt ?? null,
          staleSeconds: state.staleSeconds,
          offers: state.snapshot?.offers.length ?? 0,
          cacheAgeSeconds: state.staleSeconds,
          refreshCount: state.refreshCount,
          servingShippedSnapshot: state.servingShippedSnapshot,
          lastRefreshAttemptAt: state.lastAttemptAt,
          lastRefreshError: state.lastError,
        },
      },
      { "x-source-commit": COMMIT },
    );
  }

  const limit = rateLimited(ip);
  const rateHeaders = {
    "x-ratelimit-limit": String(RATE_LIMIT),
    "x-ratelimit-remaining": String(limit.remaining),
    "x-ratelimit-reset": String(Math.ceil(limit.resetAt / 1000)),
  };
  if (limit.limited) {
    return send(
      res,
      429,
      {
        error: "rate_limited",
        message: `This desk answers ${RATE_LIMIT} requests a minute from one address.`,
        retryAfterSeconds: Math.ceil((limit.resetAt - Date.now()) / 1000),
      },
      { ...rateHeaders, "retry-after": String(Math.ceil((limit.resetAt - Date.now()) / 1000)) },
    );
  }

  if (path === "/") return send(res, 200, INDEX, rateHeaders);
  if (path === "/v1/tools.json") return send(res, 200, TOOLS, rateHeaders);

  const state = await ensureCatalogue();
  if (!state.snapshot) {
    return send(
      res,
      503,
      {
        error: "catalogue_unavailable",
        message: "This desk has not managed to read the catalogue yet, so it will not price anything.",
        lastAttemptAt: state.lastAttemptAt,
        lastError: state.lastError,
      },
      rateHeaders,
    );
  }
  const snapshot = state.snapshot;
  const staleSeconds = state.staleSeconds ?? 0;

  if (path === "/v1/plan_call" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch (err) {
      return send(res, 400, { error: "invalid_request", message: err instanceof Error ? err.message : "unreadable body" }, rateHeaders);
    }
    const result = plan(snapshot, staleSeconds, body as never);
    const status = "error" in result ? (result.error === "unknown_model" ? 404 : 422) : 200;
    return send(res, status, result, rateHeaders);
  }

  if (path === "/v1/quote" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch (err) {
      return send(res, 400, { error: "invalid_request", message: err instanceof Error ? err.message : "unreadable body" }, rateHeaders);
    }
    const inputTokens = body.inputTokens as number;
    const outputTokens = body.outputTokens as number;
    const invalid = validateTokens({ inputTokens, outputTokens });
    if (invalid) return send(res, 422, invalid, rateHeaders);

    const modelId = String(body.modelId ?? "");
    const line = body.line === undefined ? null : String(body.line);
    const candidates = snapshot.offers.filter(
      (o) => o.modelId === modelId && (line === null || o.line === line),
    );
    if (candidates.length === 0) {
      const known = resolveModel(snapshot, modelId);
      return send(res, 404, "error" in known ? known : {
        error: "unknown_model",
        message: `The id ${modelId} is in this catalogue, but not on line ${line}.`,
        requested: { modelId, line },
        availableLines: (known as { offers: { line: string }[] }).offers.map((o) => o.line),
      }, rateHeaders);
    }

    const cachedInputTokens = Number(body.cachedInputTokens ?? 0);
    const quotes = candidates
      .map((o) => {
        const job = priceJob(o, inputTokens, outputTokens);
        const cached =
          cachedInputTokens > 0 && o.cacheHitPerMillionMicro !== null
            ? money(costOf(cachedInputTokens, o.cacheHitPerMillionMicro))
            : null;
        return {
          modelId: o.modelId,
          line: o.line,
          lineCode: o.lineCode,
          inputCost: job.input,
          outputCost: job.output,
          cachedInputCost: cached,
          totalCost: money(job.total.microUsd + (cached?.microUsd ?? 0)),
          context: o.context,
          maxOutput: o.maxOutput,
          availability: o.availability,
        };
      })
      .sort((a, b) => a.totalCost.microUsd - b.totalCost.microUsd);

    return send(res, 200, {
      modelId,
      offerCount: quotes.length,
      quotes,
      snapshotId: snapshot.snapshotId,
      pricedAt: snapshot.pricedAt,
      staleSeconds,
    }, rateHeaders);
  }

  if (path === "/v1/resolve" && req.method === "GET") {
    const modelId = url.searchParams.get("modelId") ?? "";
    const result = resolveModel(snapshot, modelId);
    return send(res, "error" in result ? 404 : 200, { ...result, staleSeconds }, rateHeaders);
  }

  if (path === "/v1/catalogue" && req.method === "GET") {
    const line = url.searchParams.get("line");
    const minContext = Number(url.searchParams.get("minContext") ?? 0);
    const rows = snapshot.offers
      .filter((o) => (line ? o.line === line : true))
      .filter((o) => o.context >= minContext)
      .slice(0, Math.min(Number(url.searchParams.get("limit") ?? MAX_ROWS), MAX_ROWS))
      .map(publicOffer);
    return send(res, 200, {
      offers: rows,
      returned: rows.length,
      totalOffers: snapshot.offers.length,
      uniqueModelIds: new Set(snapshot.offers.map((o) => o.modelId)).size,
      snapshotId: snapshot.snapshotId,
      pricedAt: snapshot.pricedAt,
      staleSeconds,
    }, rateHeaders);
  }

  if (path === "/v1/catalogue/diff" && req.method === "GET") {
    return send(res, 200, diffAgainstSubmitted(snapshot), rateHeaders);
  }

  return send(res, 404, {
    error: "not_found",
    message: `Nothing is served at ${path}.`,
    endpoints: INDEX.endpoints,
  }, rateHeaders);
}

const PORT = Number(process.env.PORT ?? 4400);

if (process.env.NODE_ENV !== "test") {
  createServer((req, res) => {
    handle(req, res).catch((err) => {
      send(res, 500, {
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }).listen(PORT, () => {
    console.log(`model desk on ${PORT}, commit ${COMMIT || "(unset)"}, limit ${MAX_TOKENS} tokens`);
  });
}
