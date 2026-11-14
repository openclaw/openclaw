import { resolveImplicitMessageActionTarget } from "../../../infra/outbound/message-action-normalization.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { isInternalMessageChannel } from "../../../utils/message-channel.js";
import type { AgentInternalEvent } from "../../internal-events.js";

export const SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION =
  "This completion ends one child run, not necessarily the original user request. Compare the result with the requested outcome before deciding the task is done. Reviews, failed checks, and other in-scope fixable blockers require continued work or a follow-up in the kept child session; report a blocker only when progress needs new user authority or an unavailable external decision.";

/**
 * Capability-matched guidance for completion turns that run without an
 * execution surface (tools disabled or a message-only allowlist). Such a turn
 * cannot continue the child's work or spawn a follow-up, so the unconditional
 * continuation clause would invite blocked tool attempts and launder this
 * turn's authority loss into a reported child failure.
 */
export const SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION =
  "This completion ends one child run, not necessarily the original user request. Compare the result with the requested outcome before deciding the task is done. This turn is a restricted relay: it has no execution, file, or session tools and cannot continue work or spawn follow-ups here. Relay the frozen child result truthfully and do not report this turn's tool restrictions as a task failure; if the result warrants follow-up work, state exactly what is needed so a subsequent normal turn can pick it up. Report a blocker only when progress needs new user authority or an unavailable external decision.";

/** Rewrites already-composed prompt or instruction text for a relay-only turn. */
export function toRelayOnlyCompletionText(text: string): string {
  return text.replaceAll(
    SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
    SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION,
  );
}

/** Rewrites the reply instruction carried by task-completion internal events. */
export function toRelayOnlyCompletionInternalEvents(
  events: AgentInternalEvent[] | undefined,
): AgentInternalEvent[] | undefined {
  return events?.map((event) =>
    event.type === "task_completion"
      ? { ...event, replyInstruction: toRelayOnlyCompletionText(event.replyInstruction) }
      : event,
  );
}

export function buildSubagentPrivateCompletionInstruction(
  requesterOrigin: DeliveryContext | undefined,
): string {
  const hasDeliveryTarget =
    isInternalMessageChannel(requesterOrigin?.channel) ||
    Boolean(
      resolveImplicitMessageActionTarget({ currentMessagingTarget: requesterOrigin?.to }, "send"),
    );
  const replyInstruction = hasDeliveryTarget
    ? "Your final reply stays internal: briefly record the reviewed outcome and any remaining work. If the original request requires a user-facing update, send it through an available, permitted messaging tool; do not rely on your final reply for delivery."
    : "Your final reply is recorded in this session for the requester: briefly record the reviewed outcome and any remaining work; no messaging send is needed.";
  return `Process this result privately. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} ${replyInstruction} Avoid repeating an update that was already delivered.`;
}
