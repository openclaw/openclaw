import type { CallManager } from "../manager.js";
import { TerminalStates } from "../types.js";

const CHECK_INTERVAL_MS = 30_000;

/**
 * Starts a periodic cleanup loop for outbound calls that never reach answered state.
 *
 * Returns a stop function when enabled, or null when the configured threshold
 * disables stale-call cleanup.
 */
export function startStaleCallReaper(params: {
  /** Call manager that owns active-call enumeration and provider hangup/finalization. */
  manager: CallManager;
  /** Maximum unanswered call age in seconds; missing or non-positive disables the loop. */
  staleCallReaperSeconds?: number;
}): (() => void) | null {
  const maxAgeSeconds = params.staleCallReaperSeconds;
  // A missing or non-positive threshold disables the reaper without installing timers.
  if (!maxAgeSeconds || maxAgeSeconds <= 0) {
    return null;
  }

  const maxAgeMs = maxAgeSeconds * 1000;
  const interval = setInterval(() => {
    const now = Date.now();
    for (const call of params.manager.getActiveCalls()) {
      // Only reap unanswered in-flight calls; answered or terminal calls are owned
      // by normal lifecycle handling even if their startedAt timestamp is old.
      if (call.answeredAt || TerminalStates.has(call.state)) {
        continue;
      }

      const age = now - call.startedAt;
      if (age > maxAgeMs) {
        console.log(
          `[voice-call] Reaping stale call ${call.callId} (age: ${Math.round(age / 1000)}s, state: ${call.state})`,
        );
        void params.manager.endCall(call.callId).catch((err: unknown) => {
          // Keep the interval alive if a provider hangup fails; the next tick can retry
          // while logging the provider/runtime failure for operators.
          console.warn(`[voice-call] Reaper failed to end call ${call.callId}:`, err);
        });
      }
    }
  }, CHECK_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
}
