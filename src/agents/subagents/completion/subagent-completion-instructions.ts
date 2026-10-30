import { resolveImplicitMessageActionTarget } from "../../../infra/outbound/message-action-normalization.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { isInternalMessageChannel } from "../../../utils/message-channel.js";

export const SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION =
  "This completion ends one child run, not necessarily the original user request. Compare the result with the requested outcome before deciding the task is done. Reviews, failed checks, and other in-scope fixable blockers require continued work or a follow-up in the kept child session; report a blocker only when progress needs new user authority or an unavailable external decision.";

export const SUBAGENT_FAILURE_RECOVERY_INSTRUCTION =
  "This child failed. Use its cause and saved partial progress to recover within your existing authority: continue the work yourself or delegate the remaining work. Do not revive the failed run to summarize its descendants. Only a genuinely human-owned decision should become an ask_user question, if available, with meaningful options, the recommended option first, and free text. A nested agent must return that blocker to its parent. Do not ask whether to retry or stop for an ordinary recoverable fault.";

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
