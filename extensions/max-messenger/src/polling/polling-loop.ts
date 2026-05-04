/**
 * Long-polling loop for the MAX channel supervisor (per
 * docs/max-plugin/plan.md §6.1.6 + §6.1.4 failure-mode table).
 *
 * Bypasses `bot.start()` per §9 N2 resolution: this loop calls
 * `GET /updates` directly through {@link pollingHttpRequest}, dispatches each
 * update via the caller-supplied `dispatch`, atomically commits the marker
 * after the batch, and handles transient failures with exponential backoff +
 * jitter.
 *
 * Ordering (per plan §6.1.6 pseudocode):
 *
 *   for each update in batch:
 *     extract dedupKey
 *     if seen → skip
 *     dispatch(update)         ← swallow exceptions per-update
 *     dedup.add(dedupKey)
 *   markerStore.set(nextMarker, tokenHash)   ← AFTER dispatch loop
 *
 * Marker is committed only after every update in the batch has been attempted
 * so a crash mid-dispatch on an N-update batch loses no events on the next
 * restart (the same batch replays; dedup drops the ones already dispatched).
 */

import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import type { DedupCache } from "./dedup-cache.js";
import type { MarkerStore } from "./marker-store.js";
import {
  NetworkError,
  pollingHttpRequest,
  RetryAfterError,
  ServerError,
  TimeoutError,
  UnauthorizedError,
} from "./polling-http.js";

const REQUEST_TIMEOUT_SLACK_SEC = 10;
const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_JITTER_RATIO = 0.2;

export type PollingLogger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Subset of the `@maxhub/max-bot-api` `Update` union we observe in practice.
 * The dedup-key extractor only needs `body.mid` for messages and
 * `callback.callback_id` for callbacks; everything else is opaque to the
 * loop and forwarded to `dispatch` as-is.
 */
export type PollingUpdate = {
  update_type: string;
  timestamp?: number;
  message?: {
    body?: {
      mid?: string | null;
    } | null;
  } | null;
  callback?: {
    callback_id?: string | null;
  } | null;
} & Record<string, unknown>;

export type PollingResponse = {
  updates: PollingUpdate[];
  marker: number;
};

export type PollingLoopOptions = {
  apiRoot: string;
  token: string;
  tokenHash: string;
  /** Long-poll request hold (seconds). Default channel config: 30. */
  timeoutSec: number;
  /** Initial transient-error backoff (ms). Default channel config: 1000. */
  retryBackoffMs: number;
  /** Backoff cap (ms). Default channel config: 30000. */
  maxBackoffMs: number;
  /** Jitter spread on backoff. Default 0.2 (±20%). */
  jitterRatio?: number;
  /** Items per batch — passed straight to `?limit=`. */
  batchLimit?: number;
  markerStore: MarkerStore;
  dedup: DedupCache;
  /** Per-update agent / handler dispatch. Exceptions are caught per update. */
  dispatch: (update: PollingUpdate) => Promise<void> | void;
  /** Caller-driven shutdown signal — also wired into the HTTP wrapper. */
  stopSignal: AbortSignal;
  log: PollingLogger;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  random?: () => number;
  /**
   * Override the per-request HTTP timeout. Defaults to
   * `(timeoutSec + 10) * 1000` ms (the slack accounts for network latency
   * past the long-poll hold). Tests pass a tighter value to drive
   * `slow-response` scenarios without waiting 11+ seconds.
   */
  requestTimeoutMs?: number;
};

/** Extract the stable dedup key, or undefined when none is available. */
export function extractDedupKey(update: PollingUpdate): string | undefined {
  const mid = update.message?.body?.mid;
  if (typeof mid === "string" && mid !== "") {
    return `msg:${mid}`;
  }
  const callbackId = update.callback?.callback_id;
  if (typeof callbackId === "string" && callbackId !== "") {
    return `cb:${callbackId}`;
  }
  return undefined;
}

function applyJitter(ms: number, ratio: number, random: () => number): number {
  if (ratio <= 0) {
    return ms;
  }
  const delta = ms * ratio;
  const offset = (random() * 2 - 1) * delta;
  return Math.max(0, Math.round(ms + offset));
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  try {
    await setTimeoutPromise(ms, undefined, { signal });
  } catch {
    // AbortError is fine — the outer loop checks `signal.aborted` next.
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drive the polling loop until `stopSignal` aborts or the loop hits a fatal
 * error (currently only `UnauthorizedError`). Returns the terminal reason so
 * callers (lifecycle adapter, integration tests) can surface it through the
 * status sink.
 *
 * Resolves with:
 *   - `"aborted"` when the caller signal fires (graceful shutdown).
 *   - `"unauthorized"` when MAX returns 401 (token revoked / invalid).
 *
 * Never rejects on transient transport errors — those drive the inner backoff.
 */
export async function runPollingLoop(
  opts: PollingLoopOptions,
): Promise<"aborted" | "unauthorized"> {
  const { stopSignal, log, dedup, markerStore } = opts;
  const jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = opts.random ?? Math.random;
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const requestTimeoutMs =
    opts.requestTimeoutMs ?? (opts.timeoutSec + REQUEST_TIMEOUT_SLACK_SEC) * 1000;

  // Resume from persisted marker, or start fresh on first run / token rotation.
  const loaded = await markerStore.load(opts.tokenHash);
  let marker: number | undefined = loaded.marker;
  if (loaded.invalidated) {
    log.info("max-messenger.polling.marker_reset", { reason: "token_hash_changed" });
  }

  let backoffMs = opts.retryBackoffMs;
  let consecutiveFailures = 0;

  while (!stopSignal.aborted) {
    let response: PollingResponse;
    try {
      response = await pollingHttpRequest<PollingResponse>({
        apiRoot: opts.apiRoot,
        path: "/updates",
        method: "GET",
        token: opts.token,
        query: {
          ...(marker !== undefined ? { marker } : {}),
          timeout: opts.timeoutSec,
          limit: batchLimit,
        },
        signal: stopSignal,
        requestTimeoutMs,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    } catch (err) {
      if (stopSignal.aborted || isAbortError(err)) {
        // Caller cancelled mid-poll. The in-flight request is already aborted
        // by the composed signal; bail without writing the marker.
        return "aborted";
      }
      if (err instanceof UnauthorizedError) {
        log.error("max-messenger.polling.fatal", { reason: "unauthorized" });
        return "unauthorized";
      }
      consecutiveFailures += 1;
      let sleepMs: number;
      let reason: string;
      if (err instanceof RetryAfterError) {
        // Honor server-given duration exactly; do not double-backoff.
        sleepMs = err.retryAfterMs;
        reason = "retry_after";
      } else if (err instanceof ServerError) {
        reason = `server_${err.status}`;
        sleepMs = applyJitter(backoffMs, jitterRatio, random);
        backoffMs = Math.min(backoffMs * 2, opts.maxBackoffMs);
      } else if (err instanceof NetworkError) {
        reason = "network";
        sleepMs = applyJitter(backoffMs, jitterRatio, random);
        backoffMs = Math.min(backoffMs * 2, opts.maxBackoffMs);
      } else if (err instanceof TimeoutError) {
        reason = "request_timeout";
        sleepMs = applyJitter(backoffMs, jitterRatio, random);
        backoffMs = Math.min(backoffMs * 2, opts.maxBackoffMs);
      } else {
        reason = "unexpected";
        sleepMs = applyJitter(backoffMs, jitterRatio, random);
        backoffMs = Math.min(backoffMs * 2, opts.maxBackoffMs);
      }
      log.warn("max-messenger.polling.restart", {
        reason,
        consecutiveFailures,
        sleepMs,
        error: errorMessage(err),
      });
      await abortableSleep(sleepMs, stopSignal);
      continue;
    }

    // Successful response — reset backoff before any per-update work so that
    // a dispatch failure doesn't bleed into next-iteration sleep timing.
    backoffMs = opts.retryBackoffMs;
    consecutiveFailures = 0;

    for (const update of response.updates) {
      if (stopSignal.aborted) {
        return "aborted";
      }
      const dedupKey = extractDedupKey(update);
      if (dedupKey !== undefined && dedup.has(dedupKey)) {
        log.info("max-messenger.polling.dedup_drop", {
          dedupKey,
          update_type: update.update_type,
        });
        continue;
      }
      if (dedupKey === undefined) {
        log.warn("max-messenger.polling.dedup_key_missing", {
          update_type: update.update_type,
        });
      }
      try {
        await opts.dispatch(update);
      } catch (err) {
        log.warn("max-messenger.polling.dispatch_failed", {
          update_type: update.update_type,
          error: errorMessage(err),
        });
      }
      if (dedupKey !== undefined) {
        dedup.add(dedupKey);
      }
    }

    // Commit marker after every dispatch attempt in the batch. Rejection of
    // the write is logged and absorbed; dedup covers the replay risk per §8 row 16.
    if (typeof response.marker === "number" && response.marker !== marker) {
      const nextMarker = response.marker;
      marker = nextMarker;
      try {
        await markerStore.set(nextMarker, opts.tokenHash);
      } catch (err) {
        log.warn("max-messenger.polling.marker_write_failed", {
          marker: nextMarker,
          error: errorMessage(err),
        });
      }
    }
  }

  return "aborted";
}
