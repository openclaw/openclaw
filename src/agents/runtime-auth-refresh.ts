/**
 * Runtime auth refresh timer helper.
 *
 * Clamps refresh deadlines before they are passed to setTimeout and backstops a
 * single refresh against a hard deadline.
 */
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";

// Timer helper for runtime auth refresh scheduling.
/** Clamp an auth refresh deadline to a safe setTimeout delay. */
export function clampRuntimeAuthRefreshDelayMs(params: {
  refreshAt: number;
  now: number;
  minDelayMs: number;
}): number {
  return resolveSafeTimeoutDelayMs(params.refreshAt - params.now, { minMs: params.minDelayMs });
}

// Hard backstop for a single runtime auth refresh. The worst legitimate case
// is two serialized in-lock budgets: waiting out a peer's held refresh lock
// for its full critical section (OAUTH_REFRESH_INLOCK_TIMEOUT_MS, 150s) and
// then running our own (another 150s) = 300s. 360s keeps 60s of real headroom
// above that so legitimate contention never misreports as a hard timeout,
// while any refresh that hangs indefinitely (a provider auth hook,
// keychain/lock wait, or token endpoint that never settles) is still forced to
// reject. Without this backstop the single-flight `refreshInFlight` promise
// can stay pending forever and every subsequent model turn deadlocks awaiting
// it.
export const RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS = 360_000;

/**
 * Thrown when the hard deadline fires and abandons still-running auth work.
 * The work cannot be cancelled, so callers use this type to invalidate any
 * state snapshot the abandoned continuation could later write back.
 */
export class RuntimeAuthDeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`Runtime auth operation for ${label} exceeded hard deadline (${timeoutMs}ms)`);
    this.name = "RuntimeAuthDeadlineError";
  }
}

/**
 * Races a runtime auth operation (refresh, cold-start prep, profile rotation)
 * against a hard deadline so the caller's promise always settles. On timeout
 * the underlying work is abandoned (it cannot be cancelled) and a descriptive
 * error is thrown; the caller clears any single-flight handle in its own
 * `finally`.
 */
export async function withRuntimeAuthRefreshDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await work;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RuntimeAuthDeadlineError(label, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
