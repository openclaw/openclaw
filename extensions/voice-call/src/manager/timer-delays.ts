import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

// Timer delay normalization helpers for voice-call lifecycle timers.

/** Convert seconds to a safe timeout delay in milliseconds. */
export function resolveVoiceCallSecondsTimerDelayMs(seconds: number, minMs = 1): number {
  if (!Number.isFinite(seconds)) {
    return resolveTimerTimeoutMs(MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_MS, minMs);
  }
  const timeoutMs = Math.floor(seconds * 1000);
  return resolveTimerTimeoutMs(
    Number.isFinite(timeoutMs) ? timeoutMs : MAX_TIMER_TIMEOUT_MS,
    minMs,
    minMs,
  );
}
