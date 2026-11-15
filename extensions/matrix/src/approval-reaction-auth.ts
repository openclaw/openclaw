import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import { getMatrixApprovalApprovers } from "./exec-approvals.js";
import type { CoreConfig } from "./types.js";

export function isMatrixApprovalReactionAuthorizedSender(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  senderId?: string | null;
  approvalKind: ChannelApprovalKind;
}): boolean {
  const normalizedSenderId = params.senderId
    ? normalizeMatrixApproverId(params.senderId)
    : undefined;
  if (!normalizedSenderId) {
    return false;
  }
  return getMatrixApprovalApprovers(params).includes(normalizedSenderId);
}
