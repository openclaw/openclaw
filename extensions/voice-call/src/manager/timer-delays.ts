import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

/** Converts provider/config seconds into a Node-safe timer delay in milliseconds. */
export function resolveVoiceCallSecondsTimerDelayMs(seconds: number, minMs = 1): number {
  if (!Number.isFinite(seconds)) {
    return resolveTimerTimeoutMs(MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_MS, minMs);
  }
  const timeoutMs = Math.floor(seconds * 1000);
  // Extremely large second values can overflow to Infinity before the timer clamp runs.
  return resolveTimerTimeoutMs(
    Number.isFinite(timeoutMs) ? timeoutMs : MAX_TIMER_TIMEOUT_MS,
    minMs,
    minMs,
  );
}

/** Clamps millisecond timer input with a fallback for invalid values. */
export function resolveVoiceCallTimerDelayMs(timeoutMs: number, fallbackMs = 1): number {
  return resolveTimerTimeoutMs(timeoutMs, fallbackMs);
}
