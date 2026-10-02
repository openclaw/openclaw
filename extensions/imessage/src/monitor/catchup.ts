import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import type {
  PluginStateCompareIntent,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { IMessageAccountConfig } from "../account-types.js";
import { getIMessageRuntime } from "../runtime.js";
import {
  IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
  IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
  resolveIMessageCatchupCursorKey,
  capFailureRetriesMap,
  type IMessageCatchupCursor,
} from "../state-contract.js";

// Legacy opt-in catchup replays missed chat.db rows through the live inbound
// evaluation and dispatch path (openclaw/openclaw#78649).

const DEFAULT_MAX_AGE_MINUTES = 120;
const MAX_MAX_AGE_MINUTES = 12 * 60;
const DEFAULT_PER_RUN_LIMIT = 50;
const MAX_PER_RUN_LIMIT = 500;
const DEFAULT_FIRST_RUN_LOOKBACK_MINUTES = 30;
const DEFAULT_MAX_FAILURE_RETRIES = 10;
const MAX_MAX_FAILURE_RETRIES = 1_000;
const cursorWriteQueue = new KeyedAsyncQueue();

type IMessageCatchupConfig = NonNullable<IMessageAccountConfig["catchup"]>;

export type IMessageCatchupRow = {
  guid: string;
  rowid: number;
  /** Timestamp in ms since epoch. */
  date: number;
  isFromMe?: boolean;
};

export type IMessageCatchupSummary = {
  querySucceeded: boolean;
  fullyCaughtUp: boolean;
  fetchedCount: number;
  replayed: number;
  skippedFromMe: number;
  skippedPreCursor: number;
  /** GUIDs already at the retry ceiling before this pass. */
  skippedGivenUp: number;
  failed: number;
  /** GUIDs that reached the retry ceiling during this pass. */
  givenUp: number;
  cursorBefore: { lastSeenMs: number; lastSeenRowid: number } | null;
  cursorAfter: { lastSeenMs: number; lastSeenRowid: number };
  windowStartMs: number;
  windowEndMs: number;
};

function openCatchupCursorStore(): PluginStateKeyedStore<IMessageCatchupCursor> {
  return getIMessageRuntime().state.openKeyedStore<IMessageCatchupCursor>({
    namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
    maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
  });
}

function sanitizeFailureRetriesInput(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [guid, count] of Object.entries(raw as Record<string, unknown>)) {
    if (!guid) {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    out[guid] = Math.floor(count);
  }
  return out;
}

function normalizeIMessageCatchupCursor(value: unknown): IMessageCatchupCursor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<IMessageCatchupCursor>;
  if (typeof raw.lastSeenMs !== "number" || !Number.isFinite(raw.lastSeenMs)) {
    return null;
  }
  if (typeof raw.lastSeenRowid !== "number" || !Number.isFinite(raw.lastSeenRowid)) {
    return null;
  }
  const failureRetries = sanitizeFailureRetriesInput(raw.failureRetries);
  const hasRetries = Object.keys(failureRetries).length > 0;
  return {
    lastSeenMs: raw.lastSeenMs,
    lastSeenRowid: raw.lastSeenRowid,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    ...(hasRetries ? { failureRetries } : {}),
  };
}

async function loadIMessageCatchupCursor(accountId: string): Promise<IMessageCatchupCursor | null> {
  return normalizeIMessageCatchupCursor(
    await openCatchupCursorStore().lookup(resolveIMessageCatchupCursorKey(accountId)),
  );
}

function buildIMessageCatchupCursor(
  next: {
    lastSeenMs: number;
    lastSeenRowid: number;
    failureRetries?: Record<string, number>;
  },
  updatedAt: number,
): IMessageCatchupCursor {
  const sanitized = sanitizeFailureRetriesInput(next.failureRetries);
  const hasRetries = Object.keys(sanitized).length > 0;
  return {
    lastSeenMs: next.lastSeenMs,
    lastSeenRowid: next.lastSeenRowid,
    updatedAt,
    ...(hasRetries ? { failureRetries: sanitized } : {}),
  };
}

function decideCatchupCursorSave(
  existingValue: IMessageCatchupCursor | undefined,
  cursor: IMessageCatchupCursor,
  allowCursorRewindForRetries: boolean,
): PluginStateCompareIntent<IMessageCatchupCursor> {
  const existing = normalizeIMessageCatchupCursor(existingValue);
  if (existing && cursor.lastSeenRowid < existing.lastSeenRowid) {
    if (!allowCursorRewindForRetries) {
      return { operation: "update", action: "keep" };
    }
    return {
      operation: "update",
      action: "set",
      value: buildIMessageCatchupCursor(
        {
          lastSeenMs: cursor.lastSeenMs,
          lastSeenRowid: cursor.lastSeenRowid,
          failureRetries: { ...existing.failureRetries, ...cursor.failureRetries },
        },
        cursor.updatedAt,
      ),
    };
  }
  return { operation: "update", action: "set", value: cursor };
}

async function saveIMessageCatchupCursor(
  accountId: string,
  next: { lastSeenMs: number; lastSeenRowid: number; failureRetries?: Record<string, number> },
  options: { allowCursorRewindForRetries?: boolean } = {},
): Promise<void> {
  const cursor = buildIMessageCatchupCursor(next, Date.now());
  const allowCursorRewindForRetries = options.allowCursorRewindForRetries === true;
  await updateIMessageCatchupCursor(accountId, (existing) =>
    decideCatchupCursorSave(existing, cursor, allowCursorRewindForRetries),
  );
}

async function updateIMessageCatchupCursor(
  accountId: string,
  decide: (
    existing: IMessageCatchupCursor | undefined,
  ) => PluginStateCompareIntent<IMessageCatchupCursor>,
): Promise<boolean> {
  const store = openCatchupCursorStore();
  if (!store.observe || !store.compareAndApply) {
    throw new Error(
      "iMessage catchup cursor persistence requires plugin-state comparison support.",
    );
  }
  const key = resolveIMessageCatchupCursorKey(accountId);
  let observation = await store.observe(key);
  for (;;) {
    const intent = decide(observation.value);
    const result = await store.compareAndApply(key, observation.comparison, intent);
    if (result.status !== "conflict") {
      return result.status === "applied";
    }
    observation = result.current;
  }
}

export type ResolvedCatchupConfig = Required<IMessageCatchupConfig>;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min, max });
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
}) => Promise<{
  resolved: boolean;
  rows: IMessageCatchupRow[];
  /** Raw response watermark, including unparseable rows, to prevent replay stalls. */
  highWatermarkRowid?: number;
  /** Companion to `highWatermarkRowid` — highest `date` seen in the raw response. */
  highWatermarkMs?: number;
  /**
   * True when the fetcher reached every eligible source row for this pass.
   * False means a best-effort partial pass occurred (for example one chat
   * history fetch failed, or the global cap left rows for a later startup).
   */
  fullyCaughtUp?: boolean;
}>;

export type CatchupDispatchFn = (row: IMessageCatchupRow) => Promise<{ ok: boolean }>;

type PerformCatchupParams = {
  accountId: string;
  config: ResolvedCatchupConfig;
  now?: number;
  fetch: CatchupFetchFn;
  dispatch: CatchupDispatchFn;
  observeSkippedFromMe?: (row: IMessageCatchupRow) => Promise<void> | void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

function decideLiveCatchupCursorAdvance(
  existingValue: IMessageCatchupCursor | undefined,
  next: IMessageCatchupCursor,
  maxFailureRetries: number,
): PluginStateCompareIntent<IMessageCatchupCursor> {
  const cursor = normalizeIMessageCatchupCursor(existingValue);
  if (cursor && next.lastSeenRowid <= cursor.lastSeenRowid) {
    return { operation: "update", action: "keep" };
  }
  const blockingFailure = Object.values(cursor?.failureRetries ?? {}).some(
    (count) => count < maxFailureRetries,
  );
  if (blockingFailure) {
    return { operation: "update", action: "keep" };
  }
  return {
    operation: "update",
    action: "set",
    value: buildIMessageCatchupCursor(
      {
        lastSeenMs: Math.max(cursor?.lastSeenMs ?? next.lastSeenMs, next.lastSeenMs),
        lastSeenRowid: next.lastSeenRowid,
        failureRetries: cursor?.failureRetries,
      },
      next.updatedAt,
    ),
  };
}

export async function advanceIMessageCatchupCursor(
  accountId: string,
  next: { lastSeenMs: number; lastSeenRowid: number },
  config: ResolvedCatchupConfig,
): Promise<boolean> {
  if (!Number.isFinite(next.lastSeenMs) || !Number.isFinite(next.lastSeenRowid)) {
    return false;
  }

  return await cursorWriteQueue.enqueue(resolveIMessageCatchupCursorKey(accountId), async () => {
    const cursor = buildIMessageCatchupCursor(next, Date.now());
    const maxFailureRetries = config.maxFailureRetries;
    return updateIMessageCatchupCursor(accountId, (existing) =>
      decideLiveCatchupCursorAdvance(existing, cursor, maxFailureRetries),
    );
  });
}

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
    fullyCaughtUp: false,
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
  summary.fullyCaughtUp = fetchResult.fullyCaughtUp !== false;
  summary.fetchedCount = fetchResult.rows.length;

  // Stable order: process oldest-first so the cursor advances monotonically
  // and a mid-run failure leaves a usable lastSeenRowid for the next pass.
  const rows = fetchResult.rows.toSorted((a, b) => a.rowid - b.rowid);
  const failureRetries = { ...cursor?.failureRetries };

  // Held failures cap the persisted cursor below their rowid so the next pass
  // retries them. Durable ingress tombstones reject replayed successes above it.
  const cursorBeforeMs = cursor?.lastSeenMs ?? windowStartMs;
  const cursorBeforeRowid = cursor?.lastSeenRowid ?? 0;
  let highWatermarkMs = cursorBeforeMs;
  let highWatermarkRowid = cursorBeforeRowid;
  let earliestHeldFailureRow: IMessageCatchupRow | null = null;

  for (const row of rows) {
    if (row.rowid <= sinceRowid) {
      summary.skippedPreCursor += 1;
      continue;
    }
    if (row.date < ageBoundMs) {
      // Row predates the recency ceiling. Skip but advance the cursor so we
      // don't re-fetch it next pass.
      summary.skippedPreCursor += 1;
      highWatermarkMs = Math.max(highWatermarkMs, row.date);
      highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
      continue;
    }
    if (row.isFromMe) {
      try {
        await params.observeSkippedFromMe?.(row);
      } catch (err) {
        params.warn?.(
          `imessage catchup: from-me observer failed for guid=${row.guid}: ${String(err)}`,
        );
      }
      summary.skippedFromMe += 1;
      highWatermarkMs = Math.max(highWatermarkMs, row.date);
      highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
      continue;
    }
    const priorCount = failureRetries[row.guid] ?? 0;
    if (priorCount >= cfg.maxFailureRetries) {
      summary.skippedGivenUp += 1;
      highWatermarkMs = Math.max(highWatermarkMs, row.date);
      highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
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
      highWatermarkMs = Math.max(highWatermarkMs, row.date);
      highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
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
      highWatermarkMs = Math.max(highWatermarkMs, row.date);
      highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
      continue;
    }
    // Below the retry ceiling: hold the cursor BEFORE this row so the next
    // pass retries it. Rows are sorted ascending, so the first held failure
    // is the lowest-rowid one — clamp the persisted cursor at its rowid - 1.
    if (earliestHeldFailureRow === null || row.rowid < earliestHeldFailureRow.rowid) {
      earliestHeldFailureRow = row;
    }
  }

  // Advance past unparseable source rows unless a held failure requires a retry.
  if (earliestHeldFailureRow === null) {
    if (typeof fetchResult.highWatermarkMs === "number") {
      highWatermarkMs = Math.max(highWatermarkMs, fetchResult.highWatermarkMs);
    }
    if (typeof fetchResult.highWatermarkRowid === "number") {
      highWatermarkRowid = Math.max(highWatermarkRowid, fetchResult.highWatermarkRowid);
    }
  }

  let lastSeenMs: number;
  let lastSeenRowid: number;
  if (earliestHeldFailureRow !== null) {
    lastSeenMs = Math.max(cursorBeforeMs, earliestHeldFailureRow.date - 1);
    lastSeenRowid = Math.max(cursorBeforeRowid, earliestHeldFailureRow.rowid - 1);
  } else {
    lastSeenMs = highWatermarkMs;
    lastSeenRowid = highWatermarkRowid;
  }

  const capped = capFailureRetriesMap(failureRetries);
  summary.cursorAfter = { lastSeenMs, lastSeenRowid };
  await saveIMessageCatchupCursor(
    params.accountId,
    {
      lastSeenMs,
      lastSeenRowid,
      failureRetries: capped,
    },
    {
      allowCursorRewindForRetries: earliestHeldFailureRow !== null,
    },
  );

  if (summary.replayed > 0 || summary.failed > 0 || summary.givenUp > 0) {
    params.log?.(
      `imessage catchup: replayed=${summary.replayed} skippedFromMe=${summary.skippedFromMe} skippedGivenUp=${summary.skippedGivenUp} failed=${summary.failed} givenUp=${summary.givenUp} fetchedCount=${summary.fetchedCount}`,
    );
  }
  return summary;
}
