import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "mullusi/plugin-sdk/approval-auth-runtime";
import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { normalizeSlackApproverId } from "./exec-approvals.js";

export function getSlackApprovalApprovers(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveSlackAccount(params).config;
  return resolveApprovalApprovers({
    allowFrom: account.allowFrom,
    extraAllowFrom: account.dm?.allowFrom,
    defaultTo: account.defaultTo,
    normalizeApprover: normalizeSlackApproverId,
    normalizeDefaultTo: normalizeSlackApproverId,
  });
}

export function isSlackApprovalAuthorizedSender(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId ? normalizeSlackApproverId(params.senderId) : undefined;
  if (!senderId) {
    return false;
  }
  return getSlackApprovalApprovers(params).includes(senderId);
}

export const slackApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Slack",
  resolveApprovers: ({ cfg, accountId }) => getSlackApprovalApprovers({ cfg, accountId }),
  normalizeSenderId: (value) => normalizeSlackApproverId(value),
});
