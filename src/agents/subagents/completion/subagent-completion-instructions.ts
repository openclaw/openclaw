import { resolveImplicitMessageActionTarget } from "../../../infra/outbound/message-action-normalization.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { isInternalMessageChannel } from "../../../utils/message-channel.js";

export const SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION =
  "This completion ends one child run, not necessarily the original user request. Compare the result with the requested outcome before deciding the task is done. Reviews, failed checks, and other in-scope fixable blockers require continued work or a follow-up in the kept child session; report a blocker only when progress needs new user authority or an unavailable external decision.";

export const SUBAGENT_COMPLETION_RELAY_ONLY_OUTCOME_INSTRUCTION =
  "This completion ends one child run, and this turn only relays the captured child result without execution or delegation tools. Do not attempt tool calls or follow-up runs here. Report the result truthfully; if follow-up work is needed, state what follow-up is needed so the requester can start a normal turn.";

export const SUBAGENT_COMPLETION_MESSAGE_ONLY_OUTCOME_INSTRUCTION =
  "This completion ends one child run, and this turn only relays the captured child result without execution or delegation tools (only permitted message delivery is available). Do not attempt execution or delegation calls or follow-up runs here; use only permitted message delivery when needed. Report the result truthfully; if follow-up work is needed, state what follow-up is needed so the requester can start a normal turn.";

export function rewriteSubagentCompletionReplyInstructionForRelayOnly(
  text: string,
  allowMessageDelivery = false,
): string {
  const replacement = allowMessageDelivery
    ? SUBAGENT_COMPLETION_MESSAGE_ONLY_OUTCOME_INSTRUCTION
    : SUBAGENT_COMPLETION_RELAY_ONLY_OUTCOME_INSTRUCTION;
  return text.includes(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION)
    ? text.replaceAll(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION, replacement)
    : text;
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
