import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { asRecord, normalizeWebhookMessage } from "./monitor-normalize.js";
import { processMessage } from "./monitor-processing.js";
import type { WebhookTarget } from "./monitor-shared.js";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";

// When the gateway is down, restarting, or wedged, inbound webhook POSTs from
// BB Server fail with ECONNRESET/ECONNREFUSED. BB's WebhookService does not
// retry, and its MessagePoller only re-fires webhooks on BB-side reconnect
// events (Messages.app / APNs), not on webhook-receiver recovery. Without a
// recovery pass, messages delivered during outage windows are permanently
// lost. See #66721 for design discussion and experimental validation.

const DEFAULT_MAX_AGE_MINUTES = 120;
const MAX_MAX_AGE_MINUTES = 12 * 60;
const DEFAULT_PER_RUN_LIMIT = 50;
const MAX_PER_RUN_LIMIT = 500;
const DEFAULT_FIRST_RUN_LOOKBACK_MINUTES = 30;
// Skip catchup on restarts <30s apart to avoid churn on healthy rolling
// restarts (e.g. automated repair loops, deploy scripts).
const MIN_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;

export type BlueBubblesCatchupConfig = {
  enabled?: boolean;
  maxAgeMinutes?: number;
  perRunLimit?: number;
  firstRunLookbackMinutes?: number;
};

export type BlueBubblesCatchupSummary = {
  querySucceeded: boolean;
  replayed: number;
  skippedFromMe: number;
  skippedPreCursor: number;
  failed: number;
  cursorBefore: number | null;
  cursorAfter: number;
  windowStartMs: number;
  windowEndMs: number;
  fetchedCount: number;
};

export type BlueBubblesCatchupCursor = { lastSeenMs: number; updatedAt: number };

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  // Explicit OPENCLAW_STATE_DIR overrides take precedence (including
  // per-test mkdtemp dirs in this module's test suite).
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return resolveStateDir(env);
  }
  // Default test isolation: per-pid tmpdir, no bleed into real ~/.openclaw.
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), `openclaw-vitest-${process.pid}`);
  }
  // Canonical OpenClaw state dir: honors `~` expansion + legacy/new
  // fallback. Sharing this resolver with inbound-dedupe is what guarantees
  // the catchup cursor and the dedupe state always live under the same
  // root, so a replayed GUID is recognized by the dedupe after catchup
  // re-feeds the message through processMessage.
  return resolveStateDir(env);
}

function resolveCursorFilePath(accountId: string): string {
  // Match inbound-dedupe's file layout: readable prefix + short hash so
  // account IDs that only differ by filesystem-unsafe characters do not
  // collapse onto the same file.
  const safePrefix = accountId.replace(/[^a-zA-Z0-9_-]/g, "_") || "account";
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12);
  return path.join(
    resolveStateDirFromEnv(),
    "bluebubbles",
    "catchup",
    `${safePrefix}__${hash}.json`,
  );
}

export async function loadBlueBubblesCatchupCursor(
  accountId: string,
): Promise<BlueBubblesCatchupCursor | null> {
  const filePath = resolveCursorFilePath(accountId);
  const { value } = await readJsonFileWithFallback<BlueBubblesCatchupCursor | null>(filePath, null);
  if (!value || typeof value !== "object") {
    return null;
  }
  if (typeof value.lastSeenMs !== "number" || !Number.isFinite(value.lastSeenMs)) {
    return null;
  }
  return value;
}

export async function saveBlueBubblesCatchupCursor(
  accountId: string,
  lastSeenMs: number,
): Promise<void> {
  const filePath = resolveCursorFilePath(accountId);
  const cursor: BlueBubblesCatchupCursor = { lastSeenMs, updatedAt: Date.now() };
  await writeJsonFileAtomically(filePath, cursor);
}

type FetchOpts = {
  baseUrl: string;
  password: string;
  allowPrivateNetwork: boolean;
  timeoutMs?: number;
};

export type BlueBubblesCatchupFetchResult = {
  resolved: boolean;
  messages: Array<Record<string, unknown>>;
};

export async function fetchBlueBubblesMessagesSince(
  sinceMs: number,
  limit: number,
  opts: FetchOpts,
): Promise<BlueBubblesCatchupFetchResult> {
  const ssrfPolicy = opts.allowPrivateNetwork ? { allowPrivateNetwork: true } : {};
  const url = buildBlueBubblesApiUrl({
    baseUrl: opts.baseUrl,
    path: "/api/v1/message/query",
    password: opts.password,
  });
  const body = JSON.stringify({
    limit,
    sort: "ASC",
    after: sinceMs,
    // `with` mirrors what bb-catchup.sh uses and what the normal webhook
    // payload carries, so normalizeWebhookMessage has the same fields to
    // read during replay as it does on live dispatch.
    with: ["chat", "chat.participants", "attachment"],
  });
  try {
    const res = await blueBubblesFetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      opts.timeoutMs ?? FETCH_TIMEOUT_MS,
      ssrfPolicy,
    );
    if (!res.ok) {
      return { resolved: false, messages: [] };
    }
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!json || !Array.isArray(json.data)) {
      return { resolved: false, messages: [] };
    }
    const messages: Array<Record<string, unknown>> = [];
    for (const entry of json.data) {
      const rec = asRecord(entry);
      if (rec) {
        messages.push(rec);
      }
    }
    return { resolved: true, messages };
  } catch {
    return { resolved: false, messages: [] };
  }
}

function clampCatchupConfig(raw?: BlueBubblesCatchupConfig) {
  const maxAgeMinutes = Math.min(
    Math.max(raw?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES, 1),
    MAX_MAX_AGE_MINUTES,
  );
  const perRunLimit = Math.min(
    Math.max(raw?.perRunLimit ?? DEFAULT_PER_RUN_LIMIT, 1),
    MAX_PER_RUN_LIMIT,
  );
  const firstRunLookbackMinutes = Math.min(
    Math.max(raw?.firstRunLookbackMinutes ?? DEFAULT_FIRST_RUN_LOOKBACK_MINUTES, 1),
    MAX_MAX_AGE_MINUTES,
  );
  return {
    maxAgeMs: maxAgeMinutes * 60_000,
    perRunLimit,
    firstRunLookbackMs: firstRunLookbackMinutes * 60_000,
  };
}

export type RunBlueBubblesCatchupDeps = {
  fetchMessages?: typeof fetchBlueBubblesMessagesSince;
  processMessageFn?: typeof processMessage;
  now?: () => number;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * Fetch and replay BlueBubbles messages delivered since the persisted
 * catchup cursor, feeding each through the same `processMessage` pipeline
 * live webhooks use. Safe to call on every gateway startup: replays that
 * collide with #66230's inbound dedupe cache are dropped there, so a
 * message already processed via live webhook will not be processed twice.
 *
 * Returns the run summary, or `null` when disabled, rate-limited, or
 * aborted before the first query.
 */
export async function runBlueBubblesCatchup(
  target: WebhookTarget,
  deps: RunBlueBubblesCatchupDeps = {},
): Promise<BlueBubblesCatchupSummary | null> {
  const raw = (target.account.config as { catchup?: BlueBubblesCatchupConfig }).catchup;
  if (raw?.enabled === false) {
    return null;
  }

  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? target.runtime.log;
  const error = deps.error ?? target.runtime.error;
  const fetchFn = deps.fetchMessages ?? fetchBlueBubblesMessagesSince;
  const procFn = deps.processMessageFn ?? processMessage;
  const accountId = target.account.accountId;

  const { maxAgeMs, perRunLimit, firstRunLookbackMs } = clampCatchupConfig(raw);
  const nowMs = now();
  const existing = await loadBlueBubblesCatchupCursor(accountId).catch(() => null);
  const cursorBefore = existing?.lastSeenMs ?? null;

  if (existing && nowMs >= existing.lastSeenMs && nowMs - existing.lastSeenMs < MIN_INTERVAL_MS) {
    // A recent run just committed; skip to avoid churn on rolling restarts.
    // The `nowMs >= existing.lastSeenMs` guard avoids a wall-clock-skew
    // hazard: if the host clock jumps backwards (NTP correction, manual
    // adjust), a future-dated cursor would otherwise satisfy this gate
    // forever and silently disable catchup until wall time caught up.
    return null;
  }

  const earliestAllowed = nowMs - maxAgeMs;
  const windowStartMs = existing
    ? Math.max(existing.lastSeenMs, earliestAllowed)
    : nowMs - firstRunLookbackMs;

  let baseUrl: string;
  let password: string;
  let allowPrivateNetwork = false;
  try {
    ({ baseUrl, password, allowPrivateNetwork } = resolveBlueBubblesServerAccount({
      serverUrl: target.account.baseUrl,
      password: target.account.config.password,
      accountId,
      cfg: target.config,
    }));
  } catch (err) {
    error?.(`[${accountId}] BlueBubbles catchup: cannot resolve server account: ${String(err)}`);
    return null;
  }

  const { resolved, messages } = await fetchFn(windowStartMs, perRunLimit, {
    baseUrl,
    password,
    allowPrivateNetwork,
  });

  const summary: BlueBubblesCatchupSummary = {
    querySucceeded: resolved,
    replayed: 0,
    skippedFromMe: 0,
    skippedPreCursor: 0,
    failed: 0,
    cursorBefore,
    cursorAfter: nowMs,
    windowStartMs,
    windowEndMs: nowMs,
    fetchedCount: messages.length,
  };

  if (!resolved) {
    // Leave cursor unchanged so the next run retries the same window.
    error?.(`[${accountId}] BlueBubbles catchup: message-query failed; cursor unchanged`);
    return summary;
  }

  // Track the earliest timestamp where `processMessage` threw so we never
  // advance the cursor past a retryable failure. Normalize failures (the
  // record didn't yield a usable NormalizedWebhookMessage) are treated as
  // permanent skips and do NOT block cursor advance — those payloads are
  // unlikely to ever normalize on retry, and blocking on them would wedge
  // catchup forever.
  let earliestProcessFailureTs: number | null = null;

  for (const rec of messages) {
    // Defense in depth: the server-side `after:` filter should already
    // exclude pre-cursor messages, but guard here against BB API variants
    // that return inclusive-of-boundary data.
    const ts = typeof rec.dateCreated === "number" ? rec.dateCreated : 0;
    if (ts > 0 && ts <= windowStartMs) {
      summary.skippedPreCursor++;
      continue;
    }

    // Filter fromMe early so BB's record of our own outbound sends cannot
    // enter the inbound pipeline even if normalization would accept them.
    if (rec.isFromMe === true || rec.is_from_me === true) {
      summary.skippedFromMe++;
      continue;
    }

    const normalized = normalizeWebhookMessage({ type: "new-message", data: rec });
    if (!normalized) {
      summary.failed++;
      continue;
    }
    if (normalized.fromMe) {
      summary.skippedFromMe++;
      continue;
    }

    try {
      await procFn(normalized, target);
      summary.replayed++;
    } catch (err) {
      summary.failed++;
      if (ts > 0 && (earliestProcessFailureTs === null || ts < earliestProcessFailureTs)) {
        earliestProcessFailureTs = ts;
      }
      error?.(`[${accountId}] BlueBubbles catchup: processMessage failed: ${String(err)}`);
    }
  }

  // Compute the new cursor. Default is `nowMs` so subsequent runs start
  // from the moment this sweep finished (avoiding stuck rescans of a
  // message with `dateCreated > nowMs` from minor clock skew between the
  // BB Server host and the gateway host). If any `processMessage` call
  // threw, hold the cursor just before the earliest failure so the next
  // run retries from there. The inbound-dedupe cache from #66230 keeps
  // already-replayed messages from being re-processed on that retry.
  let nextCursorMs = nowMs;
  if (earliestProcessFailureTs !== null) {
    const heldCursor = Math.max(earliestProcessFailureTs - 1, cursorBefore ?? windowStartMs);
    nextCursorMs = Math.min(heldCursor, nowMs);
  }
  summary.cursorAfter = nextCursorMs;
  await saveBlueBubblesCatchupCursor(accountId, nextCursorMs).catch((err) => {
    error?.(`[${accountId}] BlueBubbles catchup: cursor save failed: ${String(err)}`);
  });

  log?.(
    `[${accountId}] BlueBubbles catchup: replayed=${summary.replayed} ` +
      `skipped_fromMe=${summary.skippedFromMe} skipped_preCursor=${summary.skippedPreCursor} ` +
      `failed=${summary.failed} fetched=${summary.fetchedCount} ` +
      `window_ms=${nowMs - windowStartMs}`,
  );

  // Emit a distinct warning when the BB result hits perRunLimit. The cursor
  // has already advanced to nowMs, so any older messages BB would have
  // returned past the cap are unreachable on the next sweep. Loud signal
  // for operators to raise perRunLimit before a long outage silently
  // truncates inbound history.
  if (summary.fetchedCount >= perRunLimit) {
    error?.(
      `[${accountId}] BlueBubbles catchup: WARNING fetched=${summary.fetchedCount} ` +
        `hit perRunLimit=${perRunLimit}; older messages in the window may have ` +
        `been truncated. Raise channels.bluebubbles...catchup.perRunLimit if ` +
        `outages can exceed this many inbound messages.`,
    );
  }

  return summary;
}
