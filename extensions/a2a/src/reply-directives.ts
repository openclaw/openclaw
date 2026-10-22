import { A2A_TASK_STATES, type A2aTaskState } from "./a2a-model.js";

/**
 * Agent reply directives that steer the correlated A2A task lifecycle.
 *
 * An agent pauses an inbound A2A task instead of completing it by prefixing its
 * final reply with `[[input-required]] <question>` or `[[auth-required]] <note>`.
 * The directive itself is stripped: the remaining reply text becomes the task's
 * status message, i.e. exactly what the peer must answer to resume the task
 * (spec §3.1.8; a follow-up with the same `taskId` resumes it via `methods.ts`).
 */
const INTERRUPT_DIRECTIVE_RE = /^\s*\[\[(input|auth)-required\]\]\s*/i;

export type AgentInterruptDirective = {
  state: A2aTaskState;
  reason: string;
};

export function extractInterruptDirective(
  text: string | undefined,
): AgentInterruptDirective | undefined {
  if (!text) {
    return undefined;
  }
  const match = text.match(INTERRUPT_DIRECTIVE_RE);
  if (!match) {
    return undefined;
  }
  const isAuth = match[1]?.toLowerCase() === "auth";
  const reason = text.slice(match[0].length).trim();
  return {
    state: isAuth ? A2A_TASK_STATES.AUTH_REQUIRED : A2A_TASK_STATES.INPUT_REQUIRED,
    reason:
      reason ||
      (isAuth
        ? "Agent requires authorization to continue."
        : "Agent requires additional input to continue."),
  };
}
