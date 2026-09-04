import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../utils/message-channel.js";
export function shouldAwaitExecApprovalInline(params: {
  turnSourceChannel?: string;
  approvalClientConnected?: boolean;
  originNativeRouteActive?: boolean;
  approvalFollowupMode?: "agent" | "direct";
  trigger?: string;
}): boolean {
  if (params.approvalFollowupMode !== undefined) {
    return false;
  }
  // Scheduled runs cannot recover from an "approval-pending" handoff: the
  // isolated session ends and authority-close cancels the parked approval
  // seconds later. Wait inline so a connected approval client gets the full
  // approval window; allow-always there mints the standing grant and this
  // occurrence executes. Cron jobs are single-flight, so waiting cannot
  // stack runs.
  if (params.trigger === "cron") {
    return true;
  }
  const turnSourceChannel = normalizeMessageChannel(params.turnSourceChannel);
  if (!turnSourceChannel) {
    return false;
  }
  // Webchat itself is the approval client. External chat channels may wait only
  // when the Gateway selected that exact originating channel/account runtime;
  // a generic connected Control UI is not evidence that the origin can surface it.
  return turnSourceChannel === INTERNAL_MESSAGE_CHANNEL
    ? params.approvalClientConnected === true
    : params.originNativeRouteActive === true;
}
