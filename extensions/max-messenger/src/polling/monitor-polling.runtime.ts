/**
 * Lifecycle entry for the MAX polling supervisor (per
 * docs/max-plugin/plan.md §6.1.3 + §6.1.6).
 *
 * The lifecycle adapter wraps {@link runMaxPollingSupervisor} in
 * `runStoppablePassiveMonitor` (`openclaw/plugin-sdk/extension-shared`) so the
 * gateway's `ctx.abortSignal` drives shutdown. The supervisor itself owns:
 *
 *   - the dedup cache (one per account)
 *   - the marker store handle (one file per account)
 *   - the polling loop (`runPollingLoop`)
 *
 * Construction is split out from the loop body so integration tests can drive
 * the supervisor against the fake-MAX harness without going through the
 * channel plugin lifecycle.
 */

import { createDedupCache, type DedupCache } from "./dedup-cache.js";
import { createMarkerStore, hashToken, type MarkerStore } from "./marker-store.js";
import type { PollingUpdate, PollingLogger } from "./polling-loop.js";
import { runPollingLoop } from "./polling-loop.js";

export type MaxPollingSupervisorOptions = {
  /** Resolved API base URL (no trailing slash). */
  apiRoot: string;
  /** Bot token. Hashed for marker invalidation; never logged. */
  token: string;
  /** Account id; drives marker file path and log fields. */
  accountId: string;
  /** Long-poll request hold (seconds). Per plan §8 row 11: default 30. */
  timeoutSec: number;
  /** Initial transient backoff (ms). Per plan §8 row 12: default 1000. */
  retryBackoffMs: number;
  /** Backoff cap (ms). Per plan §8 row 13: default 30000. */
  maxBackoffMs: number;
  /** Per-update dispatch — typically the inbound adapter's switch skeleton. */
  dispatch: (update: PollingUpdate) => Promise<void> | void;
  /** Caller-driven shutdown (gateway abortSignal). */
  abortSignal: AbortSignal;
  log: PollingLogger;
  /**
   * Test seams. These are deliberately optional so production callers (the
   * lifecycle adapter) get the conventional defaults.
   */
  stateDir?: string;
  markerStore?: MarkerStore;
  dedup?: DedupCache;
  fetchImpl?: typeof fetch;
  random?: () => number;
  /** Override the per-request HTTP timeout (test seam — see polling-loop.ts). */
  requestTimeoutMs?: number;
};

export type MaxPollingSupervisorResult = "aborted" | "unauthorized";

/**
 * Run the supervisor until the abort signal fires (graceful) or the SDK
 * signals an unauthorized token (fatal). Resolves with the terminal reason
 * so the caller can flip the gateway status sink to `"offline" /
 * "unauthorized"` accordingly.
 */
export async function runMaxPollingSupervisor(
  opts: MaxPollingSupervisorOptions,
): Promise<MaxPollingSupervisorResult> {
  if (!opts.token) {
    throw new Error(`MAX Messenger: token missing for account "${opts.accountId}".`);
  }
  if (!opts.apiRoot) {
    throw new Error(`MAX Messenger: apiRoot missing for account "${opts.accountId}".`);
  }

  const tokenHash = hashToken(opts.token);
  const markerStore =
    opts.markerStore ??
    createMarkerStore({
      accountId: opts.accountId,
      ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
    });
  const dedup = opts.dedup ?? createDedupCache();

  return await runPollingLoop({
    apiRoot: opts.apiRoot,
    token: opts.token,
    tokenHash,
    timeoutSec: opts.timeoutSec,
    retryBackoffMs: opts.retryBackoffMs,
    maxBackoffMs: opts.maxBackoffMs,
    markerStore,
    dedup,
    dispatch: opts.dispatch,
    stopSignal: opts.abortSignal,
    log: opts.log,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
}
