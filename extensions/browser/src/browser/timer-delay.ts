import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

/** Clamps timer delays to Node's safe range with an optional lower bound. */
export function normalizeBrowserTimerDelayMs(timeoutMs: number, opts?: { minMs?: number }): number {
  const minMs = resolveTimerTimeoutMs(opts?.minMs, 1, 0);
  return resolveTimerTimeoutMs(timeoutMs, minMs, minMs);
}
