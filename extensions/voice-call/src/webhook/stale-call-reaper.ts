import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { CallManager } from "../manager.js";
import { TerminalStates, type CallRecord } from "../types.js";

const CHECK_INTERVAL_MS = 30_000;

type StaleCallReaperManager = {
  getActiveCalls(): Array<Pick<CallRecord, "answeredAt" | "callId" | "startedAt" | "state">>;
  endCall: CallManager["endCall"];
};

/** Stop joins provider hangups before the call manager can close. */
export function startStaleCallReaper(params: {
  scheduler: PluginServiceSchedulerV1;
  manager: StaleCallReaperManager;
  staleCallReaperSeconds?: number;
}): (() => Promise<void>) | null {
  const maxAgeSeconds = params.staleCallReaperSeconds;
  if (!maxAgeSeconds || maxAgeSeconds <= 0 || params.scheduler.signal.aborted) {
    return null;
  }

  const maxAgeMs = maxAgeSeconds * 1000;
  const reap = async () => {
    const now = Date.now();
    const hangups: Promise<void>[] = [];
    for (const call of params.manager.getActiveCalls()) {
      // Twilio can reach a live conversation without delivering call.answered.
      if (
        call.answeredAt ||
        TerminalStates.has(call.state) ||
        call.state === "speaking" ||
        call.state === "listening"
      ) {
        continue;
      }

      // Unanswered provider calls can be stranded when callbacks are missed; end them explicitly.
      const age = now - call.startedAt;
      if (age > maxAgeMs) {
        console.log(
          `[voice-call] Reaping stale call ${call.callId} (age: ${Math.round(age / 1000)}s, state: ${call.state})`,
        );
        const operation = params.manager
          .endCall(call.callId)
          .then((result) => {
            if (!result.success) {
              console.warn(
                `[voice-call] Reaper failed to end call ${call.callId}: ${result.error ?? "unknown error"}`,
              );
            }
          })
          .catch((err: unknown) => {
            console.warn(`[voice-call] Reaper failed to end call ${call.callId}:`, err);
          });
        hangups.push(operation);
      }
    }
    await Promise.allSettled(hangups);
  };

  const scheduler = params.scheduler.scope();
  scheduler.schedule({
    id: "stale-call-reaper",
    delayMs: CHECK_INTERVAL_MS,
    everyMs: CHECK_INTERVAL_MS,
    run: reap,
  });
  return () => scheduler.stop();
}
