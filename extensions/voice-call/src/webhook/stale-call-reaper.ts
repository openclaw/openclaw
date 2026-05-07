import type { CallManager } from "../manager.js";
import { type CallState, TerminalStates } from "../types.js";

const CHECK_INTERVAL_MS = 30_000;

// States that indicate an active two-way conversation — never reap these regardless of age.
// Calls reach speaking/listening via the media stream before the provider status callback
// (e.g. Twilio CallStatus=in-progress) arrives, so answeredAt may still be null.
const ActiveConversationStates = new Set<CallState>(["speaking", "listening"]);

export function startStaleCallReaper(params: {
  manager: CallManager;
  staleCallReaperSeconds?: number;
}): (() => void) | null {
  const maxAgeSeconds = params.staleCallReaperSeconds;
  if (!maxAgeSeconds || maxAgeSeconds <= 0) {
    return null;
  }

  const maxAgeMs = maxAgeSeconds * 1000;
  const interval = setInterval(() => {
    const now = Date.now();
    for (const call of params.manager.getActiveCalls()) {
      if (
        call.answeredAt ||
        TerminalStates.has(call.state) ||
        ActiveConversationStates.has(call.state)
      ) {
        continue;
      }

      const age = now - call.startedAt;
      if (age > maxAgeMs) {
        console.log(
          `[voice-call] Reaping stale call ${call.callId} (age: ${Math.round(age / 1000)}s, state: ${call.state})`,
        );
        void params.manager.endCall(call.callId).catch((err) => {
          console.warn(`[voice-call] Reaper failed to end call ${call.callId}:`, err);
        });
      }
    }
  }, CHECK_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
}
