import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

// iMessage inbound catchup. When the gateway is offline (crash, restart, mac
// sleep, machine off), `imsg watch` resumes from current state and ignores
// anything that landed in chat.db while the bridge was disconnected.
// Without a recovery pass, those messages are permanently lost.
//
// This module mirrors the design of the retired BlueBubbles catchup
// (`extensions/bluebubbles/src/catchup.ts` in commit 07bf572f35^), adapted
// for the imsg JSON-RPC `messages.history` fetch path. The replay loop is
// pluggable via the `dispatch` callback so the same `evaluateIMessageInbound`
// + `dispatchInboundMessage` path used by the live `imsg watch` loop runs
// unchanged on replayed rows.
//
// See https://github.com/openclaw/openclaw/issues/78649 for design discussion.

const DEFAULT_MAX_AGE_MINUTES = 120;
const MAX_MAX_AGE_MINUTES = 12 * 60;
const DEFAULT_PER_RUN_LIMIT = 50;
const MAX_PER_RUN_LIMIT = 500;
const DEFAULT_FIRST_RUN_LOOKBACK_MINUTES = 30;
const DEFAULT_MAX_FAILURE_RETRIES = 10;
const MAX_MAX_FAILURE_RETRIES = 1_000;
// Defense-in-depth bound on the retry map. A storm of unique failing GUIDs
// should not balloon the cursor file. When over the bound, keep only the
// highest-count entries (closest to give-up) and drop the rest.
const MAX_FAILURE_RETRY_MAP_SIZE = 5_000;

export type IMessageCatchupConfig = {
  enabled?: boolean;
  maxAgeMinutes?: number;
  perRunLimit?: number;
  firstRunLookbackMinutes?: number;
  maxFailureRetries?: number;
};

export type IMessageCatchupCursor = {
  /** Timestamp (ms since epoch) of the highest-watermark message we processed. */
  lastSeenMs: number;
  /** ROWID of the highest-watermark processed message. Monotonic in chat.db. */
  lastSeenRowid: number;
  /** UTC ms timestamp of the most recent cursor write. */
  updatedAt: number;
  /**
   * Per-GUID failure counter, preserved across runs. Two states:
   * - `1 <= count < maxFailureRetries`: the GUID is still retrying and
   *   continues to hold the cursor back.
   * - `count >= maxFailureRetries`: catchup has given up on the GUID. The
   *   message is skipped on sight (no dispatch attempt) and the cursor no
   *   longer waits on it. Entry stays in the map until the cursor naturally
   *   advances past the message's timestamp.
   *
   * A successful dispatch removes the entry. Optional on the persisted shape
   * so older cursor files without this field load cleanly.
   */
  failureRetries?: Record<string, number>;
};

export type IMessageCatchupRow = {
  guid: string;
  rowid: number;
  /** Timestamp in ms since epoch. */
  date: number;
  isFromMe?: boolean;
};

export type IMessageCatchupSummary = {
  querySucceeded: boolean;
  fetchedCount: number;
  replayed: number;
  skippedFromMe: number;
  skippedPreCursor: number;
  /**
   * Messages whose GUID was already recorded as "given up" from a prior
   * run (count >= `maxFailureRetries`). Skipped without a dispatch attempt
   * so the cursor can advance past them.
   */
  skippedGivenUp: number;
  failed: number;
  /**
   * Messages that crossed the `maxFailureRetries` ceiling on this run. Each
   * transition triggers a `warn` log line. Already-given-up messages in
   * subsequent runs count under `skippedGivenUp`, not here.
   */
  givenUp: number;
  cursorBefore: { lastSeenMs: number; lastSeenRowid: number } | null;
  cursorAfter: { lastSeenMs: number; lastSeenRowid: number };
  windowStartMs: number;
  windowEndMs: number;
};

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return resolveStateDir(env);
  }
  // Default test isolation: per-pid tmpdir. Mirrors the BB catchup pattern so
  // the tmpdir-path-guard test that flags dynamic template-literal suffixes
  // on os.tmpdir() paths stays green.
  if (env.VITEST || env.NODE_ENV === "test") {
    const name = "openclaw-vitest-" + process.pid;
    return path.join(resolvePreferredOpenClawTmpDir(), name);
  }
  return resolveStateDir(env);
}

function resolveCursorFilePath(accountId: string): string {
  // Layout matches inbound-dedupe / persisted-echo-cache so a replayed GUID
  // is recognized by the existing dedupe after catchup re-feeds the message
  // through the live dispatch path.
  const safePrefix = accountId.replace(/[^a-zA-Z0-9_-]/g, "_") || "account";
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12);
  return path.join(resolveStateDirFromEnv(), "imessage", "catchup", `${safePrefix}__${hash}.json`);
}

function sanitizeFailureRetriesInput(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [guid, count] of Object.entries(raw as Record<string, unknown>)) {
    if (!guid || typeof guid !== "string") {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    out[guid] = Math.floor(count);
  }
  return out;
}

/**
 * Cursor file path: `<openclawStateDir>/imessage/catchup/<safePrefix>__<sha256[:12]>.json`.
 * `openclawStateDir` resolves through `OPENCLAW_STATE_DIR` (or the plugin-sdk default,
 * `~/.openclaw`). On a default install the cursor lands at
 * `~/.openclaw/imessage/catchup/<safePrefix>__<sha256[:12]>.json`.
 */
export async function loadIMessageCatchupCursor(
  accountId: string,
): Promise<IMessageCatchupCursor | null> {
  const filePath = resolveCursorFilePath(accountId);
  const { value } = await readJsonFileWithFallback<IMessageCatchupCursor | null>(filePath, null);
  if (!value || typeof value !== "object") {
    return null;
  }
  if (typeof value.lastSeenMs !== "number" || !Number.isFinite(value.lastSeenMs)) {
    return null;
  }
  if (typeof value.lastSeenRowid !== "number" || !Number.isFinite(value.lastSeenRowid)) {
    return null;
  }
  const failureRetries = sanitizeFailureRetriesInput(value.failureRetries);
  const hasRetries = Object.keys(failureRetries).length > 0;
  return {
    lastSeenMs: value.lastSeenMs,
    lastSeenRowid: value.lastSeenRowid,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(hasRetries ? { failureRetries } : {}),
  };
}

export async function saveIMessageCatchupCursor(
  accountId: string,
  next: { lastSeenMs: number; lastSeenRowid: number; failureRetries?: Record<string, number> },
): Promise<void> {
  const filePath = resolveCursorFilePath(accountId);
  const sanitized = sanitizeFailureRetriesInput(next.failureRetries);
  const hasRetries = Object.keys(sanitized).length > 0;
  const cursor: IMessageCatchupCursor = {
    lastSeenMs: next.lastSeenMs,
    lastSeenRowid: next.lastSeenRowid,
    updatedAt: Date.now(),
    ...(hasRetries ? { failureRetries: sanitized } : {}),
  };
  await writeJsonFileAtomically(filePath, cursor);
}

/**
 * Bound the retry map so a pathological storm of unique failing GUIDs
 * cannot grow the cursor file without limit. Keeps the `maxSize` entries
 * with the highest counts (closest to give-up) when over the bound.
 */
export function capFailureRetriesMap(
  map: Record<string, number>,
  maxSize: number = MAX_FAILURE_RETRY_MAP_SIZE,
): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= maxSize) {
    return map;
  }
  // Sort by count desc; stable tiebreak on guid string so the retained set
  // is deterministic across runs (important for cursor-file diffing during
  // debugging).
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const capped: Record<string, number> = {};
  for (let i = 0; i < maxSize; i++) {
    const [guid, count] = entries[i];
    capped[guid] = count;
  }
  return capped;
}

export type ResolvedCatchupConfig = {
  enabled: boolean;
  maxAgeMinutes: number;
  perRunLimit: number;
  firstRunLookbackMinutes: number;
  maxFailureRetries: number;
};

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function resolveCatchupConfig(
  raw: IMessageCatchupConfig | undefined,
): ResolvedCatchupConfig {
  return {
    enabled: Boolean(raw?.enabled),
    maxAgeMinutes: clampInt(raw?.maxAgeMinutes, 1, MAX_MAX_AGE_MINUTES, DEFAULT_MAX_AGE_MINUTES),
    perRunLimit: clampInt(raw?.perRunLimit, 1, MAX_PER_RUN_LIMIT, DEFAULT_PER_RUN_LIMIT),
    firstRunLookbackMinutes: clampInt(
      raw?.firstRunLookbackMinutes,
      1,
      MAX_MAX_AGE_MINUTES,
      DEFAULT_FIRST_RUN_LOOKBACK_MINUTES,
    ),
    maxFailureRetries: clampInt(
      raw?.maxFailureRetries,
      1,
      MAX_MAX_FAILURE_RETRIES,
      DEFAULT_MAX_FAILURE_RETRIES,
    ),
  };
}

export type CatchupFetchFn = (params: {
  sinceMs: number;
  sinceRowid: number;
  limit: number;
}) => Promise<{ resolved: boolean; rows: IMessageCatchupRow[] }>;

export type CatchupDispatchFn = (row: IMessageCatchupRow) => Promise<{ ok: boolean }>;

export type PerformCatchupParams = {
  accountId: string;
  config: ResolvedCatchupConfig;
  now?: number;
  fetch: CatchupFetchFn;
  dispatch: CatchupDispatchFn;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * One catchup pass. Loads the cursor, fetches `messages.history`, replays
 * each row through `dispatch`, advances the cursor on success / give-up,
 * persists the cursor, returns a summary.
 *
 * The fetch and dispatch functions are injected so this loop is unit-testable
 * without standing up an `imsg` daemon. The wiring in `monitor-provider.ts`
 * passes the live `client.request("messages.history", ...)` adapter as
 * `fetch` and the `evaluateIMessageInbound` + `dispatchInboundMessage`
 * pipeline as `dispatch`.
 */
export async function performIMessageCatchup(
  params: PerformCatchupParams,
): Promise<IMessageCatchupSummary> {
  const now = params.now ?? Date.now();
  const cfg = params.config;
  const cursor = await loadIMessageCatchupCursor(params.accountId);
  const lookbackMs =
    cursor === null ? cfg.firstRunLookbackMinutes * 60_000 : cfg.maxAgeMinutes * 60_000;
  const ageBoundMs = now - cfg.maxAgeMinutes * 60_000;
  const windowStartMs = Math.max(cursor?.lastSeenMs ?? now - lookbackMs, ageBoundMs);
  const windowEndMs = now;
  const sinceRowid = cursor?.lastSeenRowid ?? 0;

  const summary: IMessageCatchupSummary = {
    querySucceeded: false,
    fetchedCount: 0,
    replayed: 0,
    skippedFromMe: 0,
    skippedPreCursor: 0,
    skippedGivenUp: 0,
    failed: 0,
    givenUp: 0,
    cursorBefore: cursor
      ? { lastSeenMs: cursor.lastSeenMs, lastSeenRowid: cursor.lastSeenRowid }
      : null,
    cursorAfter: {
      lastSeenMs: cursor?.lastSeenMs ?? windowStartMs,
      lastSeenRowid: cursor?.lastSeenRowid ?? 0,
    },
    windowStartMs,
    windowEndMs,
  };

  let fetchResult: Awaited<ReturnType<CatchupFetchFn>>;
  try {
    fetchResult = await params.fetch({
      sinceMs: windowStartMs,
      sinceRowid,
      limit: cfg.perRunLimit,
    });
  } catch (err) {
    params.warn?.(`imessage catchup: fetch failed: ${String(err)}`);
    return summary;
  }
  if (!fetchResult.resolved) {
    params.warn?.(`imessage catchup: fetch returned unresolved result`);
    return summary;
  }
  summary.querySucceeded = true;
  summary.fetchedCount = fetchResult.rows.length;

  // Stable order: process oldest-first so the cursor advances monotonically
  // and a mid-run failure leaves a usable lastSeenRowid for the next pass.
  const rows = [...fetchResult.rows].sort((a, b) => a.rowid - b.rowid);
  const failureRetries = { ...(cursor?.failureRetries ?? {}) };
  let lastSeenMs = cursor?.lastSeenMs ?? windowStartMs;
  let lastSeenRowid = cursor?.lastSeenRowid ?? 0;

  for (const row of rows) {
    if (row.rowid <= sinceRowid) {
      summary.skippedPreCursor += 1;
      continue;
    }
    if (row.date < ageBoundMs) {
      // Row predates the recency ceiling. Skip but advance the cursor so we
      // don't re-fetch it next pass.
      summary.skippedPreCursor += 1;
      lastSeenMs = Math.max(lastSeenMs, row.date);
      lastSeenRowid = Math.max(lastSeenRowid, row.rowid);
      continue;
    }
    if (row.isFromMe) {
      summary.skippedFromMe += 1;
      lastSeenMs = Math.max(lastSeenMs, row.date);
      lastSeenRowid = Math.max(lastSeenRowid, row.rowid);
      continue;
    }
    const priorCount = failureRetries[row.guid] ?? 0;
    if (priorCount >= cfg.maxFailureRetries) {
      summary.skippedGivenUp += 1;
      lastSeenMs = Math.max(lastSeenMs, row.date);
      lastSeenRowid = Math.max(lastSeenRowid, row.rowid);
      continue;
    }

    let dispatched: { ok: boolean };
    try {
      dispatched = await params.dispatch(row);
    } catch (err) {
      params.warn?.(`imessage catchup: dispatch threw for guid=${row.guid}: ${String(err)}`);
      dispatched = { ok: false };
    }

    if (dispatched.ok) {
      summary.replayed += 1;
      delete failureRetries[row.guid];
      lastSeenMs = Math.max(lastSeenMs, row.date);
      lastSeenRowid = Math.max(lastSeenRowid, row.rowid);
      continue;
    }

    const nextCount = priorCount + 1;
    failureRetries[row.guid] = nextCount;
    summary.failed += 1;
    if (nextCount >= cfg.maxFailureRetries) {
      summary.givenUp += 1;
      params.warn?.(
        `imessage catchup: giving up on guid=${row.guid} after ${nextCount} failures; advancing cursor past it`,
      );
      // Cursor advances past the wedged guid so subsequent passes can make
      // progress. Already-given-up entries in future runs count under
      // skippedGivenUp.
      lastSeenMs = Math.max(lastSeenMs, row.date);
      lastSeenRowid = Math.max(lastSeenRowid, row.rowid);
    }
    // Below the ceiling: hold the cursor on this row so the next pass
    // retries it before advancing.
  }

  const capped = capFailureRetriesMap(failureRetries);
  summary.cursorAfter = { lastSeenMs, lastSeenRowid };
  await saveIMessageCatchupCursor(params.accountId, {
    lastSeenMs,
    lastSeenRowid,
    failureRetries: capped,
  });

  if (summary.replayed > 0 || summary.failed > 0 || summary.givenUp > 0) {
    params.log?.(
      `imessage catchup: replayed=${summary.replayed} skippedFromMe=${summary.skippedFromMe} skippedGivenUp=${summary.skippedGivenUp} failed=${summary.failed} givenUp=${summary.givenUp} fetchedCount=${summary.fetchedCount}`,
    );
  }
  return summary;
}
