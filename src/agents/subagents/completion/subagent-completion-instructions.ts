import { resolveImplicitMessageActionTarget } from "../../../infra/outbound/message-action-normalization.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { isInternalMessageChannel } from "../../../utils/message-channel.js";

export const SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION =
  "This completion ends one child run, not necessarily the original user request. Compare the result with the requested outcome before deciding the task is done. Reviews, failed checks, and other in-scope fixable blockers require continued work or a follow-up in the kept child session; report a blocker only when progress needs new user authority or an unavailable external decision.";

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
