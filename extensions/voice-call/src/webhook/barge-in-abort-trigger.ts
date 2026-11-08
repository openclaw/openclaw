// Owns the opt-in agent-run abort for streaming barge-in. Kept out of
// webhook.ts: that file is already over its line cap and the growth ratchet
// rejects additions, so the whole concern lives here and webhook.ts retains
// only its call sites.
import { abortAgentHarnessRun } from "openclaw/plugin-sdk/agent-harness";
import { BargeInAgentAbortCoordinator } from "../barge-in-agent-abort.js";

/** The webhook server surface this trigger reads, resolved lazily per call. */
export type BargeInAbortHost = {
  config: { bargeIn?: { abortAgentRun?: boolean } };
  logger: { info: (message: string) => void; warn: (message: string) => void };
};

export type BargeInAbortTrigger = {
  /** Guarded abort for the interrupted turn; never throws to the audio path. */
  abortForBargeIn: (callId: string) => void;
  /** Publishes the run backing this turn so barge-in can abort that exact run. */
  registerRun: (callId: string, run: { sessionId: string; runId: string }) => void;
  /** Drops this turn's tracked run, clearing only the run it registered. */
  clearTurn: (callId: string) => void;
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
export function createBargeInAbortTrigger(host: () => BargeInAbortHost): BargeInAbortTrigger {
  const coordinator = new BargeInAgentAbortCoordinator({
    // Same run-abort entry point the TUI escape key uses; it signals the run's
    // abort signal, which kills in-flight tool child processes immediately
    // instead of waiting for a tool-call boundary.
    abortAgentRun: (sessionId) => abortAgentHarnessRun(sessionId),
    log: (message) => host().logger.info(message),
  });
  // Turns overlap because handleInboundResponse is void-called, so a late
  // settle must clear only the run it started, not its replacement's.
  const runIdByCallId = new Map<string, string>();
  return {
    abortForBargeIn: (callId) => {
      try {
        // Read the flag inside the guard: this runs on the inbound transcript
        // path, and a config shape missing bargeIn must not throw past here
        // and swallow a caller audio frame.
        if (!host().config.bargeIn?.abortAgentRun) {
          return;
        }
        coordinator.abortForBargeIn({ callId, source: "streaming" });
      } catch (err) {
        // A throw here would skip the rest of barge-in handling, so clearing
        // queued audio must never depend on the agent-run abort succeeding.
        host().logger.warn(`barge-in agent run abort failed callId=${callId} error=${String(err)}`);
      }
    },
    registerRun: (callId, run) => {
      runIdByCallId.set(callId, run.runId);
      coordinator.registerRun(callId, run);
    },
    clearTurn: (callId) => {
      const runId = runIdByCallId.get(callId);
      if (runId === undefined) {
        return;
      }
      runIdByCallId.delete(callId);
      coordinator.clearRun(callId, runId);
    },
  };
}
