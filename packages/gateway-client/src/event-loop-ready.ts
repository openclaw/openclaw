import { resolveFiniteTimeoutDelayMs } from "./timeouts.js";

/** Readiness probe outcome with timing data for diagnosing event-loop stalls. */
export type EventLoopReadyResult = {
  /** True when enough consecutive timer checks stayed below the drift threshold. */
  ready: boolean;
  /** Wall-clock time spent in the readiness probe. */
  elapsedMs: number;
  /** Largest observed timer drift across all checks. */
  maxDriftMs: number;
  /** Number of scheduled timer checks that fired before completion. */
  checks: number;
  /** True when the supplied AbortSignal stopped the probe before readiness or timeout. */
  aborted: boolean;
};

/** Controls how aggressively the client waits for low-drift timer checks before starting IO. */
export type EventLoopReadyOptions = {
  /** Maximum wall-clock time to wait before reporting not ready. */
  maxWaitMs?: number;
  /** Delay between drift samples; clamped to safe Node timer bounds. */
  intervalMs?: number;
  /** Maximum acceptable timer drift for a sample to count as ready. */
  driftThresholdMs?: number;
  /** Number of low-drift samples required before the event loop is considered ready. */
  consecutiveReadyChecks?: number;
  /** Cancels the probe without starting client IO. */
  signal?: AbortSignal;
};

const DEFAULT_MAX_WAIT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 1;
const DEFAULT_DRIFT_THRESHOLD_MS = 200;
const DEFAULT_CONSECUTIVE_READY_CHECKS = 2;

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(1, Math.floor(value)) : fallback;
}

/** Waits until timer drift stays low for consecutive checks, or aborts/times out. */
export async function waitForEventLoopReady(
  options: EventLoopReadyOptions = {},
): Promise<EventLoopReadyResult> {
  const maxWaitMs = resolveFiniteTimeoutDelayMs(options.maxWaitMs, DEFAULT_MAX_WAIT_MS, {
    minMs: 0,
  });
  const intervalMs = resolveFiniteTimeoutDelayMs(options.intervalMs, DEFAULT_INTERVAL_MS);
  const driftThresholdMs = resolvePositiveInteger(
    options.driftThresholdMs,
    DEFAULT_DRIFT_THRESHOLD_MS,
  );
  const consecutiveReadyChecks = resolvePositiveInteger(
    options.consecutiveReadyChecks,
    DEFAULT_CONSECUTIVE_READY_CHECKS,
  );
  const signal = options.signal;

  const startedAt = Date.now();
  let readyChecks = 0;
  let checks = 0;
  let maxDriftMs = 0;

  return await new Promise<EventLoopReadyResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (ready: boolean, aborted = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      signal?.removeEventListener("abort", onAbort);
      resolve({
        ready,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        maxDriftMs,
        checks,
        aborted,
      });
    };
    const onAbort = () => {
      finish(false, true);
    };
    if (signal?.aborted) {
      finish(false, true);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const scheduleNext = () => {
      if (signal?.aborted) {
        finish(false, true);
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const remainingMs = maxWaitMs - elapsedMs;
      if (remainingMs <= 0) {
        finish(false);
        return;
      }
      const delayMs = Math.min(intervalMs, remainingMs);
      const scheduledAt = Date.now();
      timer = setTimeout(() => {
        timer = null;
        checks += 1;
        const driftMs = Math.max(0, Date.now() - scheduledAt - delayMs);
        maxDriftMs = Math.max(maxDriftMs, driftMs);
        if (driftMs > driftThresholdMs) {
          readyChecks = 0;
        } else {
          // Require consecutive low-drift samples so one lucky timer after a
          // blocked loop does not start IO while the process is still saturated.
          readyChecks += 1;
        }
        if (readyChecks >= consecutiveReadyChecks) {
          finish(true);
          return;
        }
        scheduleNext();
      }, delayMs);
    };

    scheduleNext();
  });
}
