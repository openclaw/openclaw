// Owns the opt-in agent-run abort for streaming barge-in. Kept out of
// webhook.ts: that file is already over its line cap and the growth ratchet
// rejects additions, so the whole concern lives here and webhook.ts retains
// only its call sites.
import {
  BargeInAgentAbortCoordinator,
  type BargeInTrackedAgentRun,
} from "../barge-in-agent-abort.js";

export type BargeInAbortTrigger = {
  /** Guarded abort for the interrupted turn; never throws to the audio path. */
  abortForBargeIn: (callId: string) => void;
  /**
   * Publishes the run backing this turn so barge-in can abort that exact run.
   *
   * Returns the cleanup for this response, bound to the run it registered. The
   * caller holds it instead of re-deriving identity at removal time, so a late
   * settle cannot drop the run that replaced it.
   */
  registerRun: (callId: string, run: BargeInTrackedAgentRun) => () => void;
};

/**
 * Build the streaming barge-in abort trigger.
 *
 * The coordinator is always constructed and stays inert unless
 * `bargeIn.abortAgentRun` is set, so audio-only barge-in is unchanged by
 * default. The host is resolved lazily rather than captured, because the flag
 * can change under a config hot reload and the logger is assigned in the
 * webhook server's constructor, after field initializers run.
 */
export function createBargeInAbortTrigger(
  getConfig: () => { bargeIn?: { abortAgentRun?: boolean } },
  logger: { info: (message: string) => void; warn: (message: string) => void },
): BargeInAbortTrigger {
  // The run carries its own cancellation authority, so there is no session-keyed
  // abort entry point here and no second registry to keep in step: the
  // coordinator is the single owner of what is tracked per call.
  const coordinator = new BargeInAgentAbortCoordinator({
    log: (message) => logger.info(message),
  });
  return {
    abortForBargeIn: (callId) => {
      try {
        // Read the flag inside the guard: this runs on the inbound transcript
        // path, and a config shape missing bargeIn must not throw past here
        // and swallow a caller audio frame.
        if (!getConfig().bargeIn?.abortAgentRun) {
          return;
        }
        coordinator.abortForBargeIn({ callId, source: "streaming" });
      } catch (err) {
        // A throw here would skip the rest of barge-in handling, so clearing
        // queued audio must never depend on the agent-run abort succeeding.
        logger.warn(`barge-in agent run abort failed callId=${callId} error=${String(err)}`);
      }
    },
    registerRun: (callId, run) => {
      coordinator.registerRun(callId, run);
      // Turns overlap because handleInboundResponse is void-called. Closing over
      // this run's id is what makes a late settle a no-op rather than a clear of
      // its replacement.
      return () => coordinator.clearRun(callId, run.runId);
    },
  };
}
