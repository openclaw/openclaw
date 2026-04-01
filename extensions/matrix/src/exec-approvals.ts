import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalTargetRecipient,
  resolveApprovalRequestAccountId,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export function normalizeMatrixApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixUserId(String(value));
  return normalized || undefined;
}

export function getMatrixExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveMatrixAccount(params).config;
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers,
    allowFrom: account.dm?.allowFrom,
    normalizeApprover: normalizeMatrixApproverId,
  });
}

export function isMatrixExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "matrix",
    normalizeSenderId: normalizeMatrixApproverId,
    matchTarget: ({ target, normalizedSenderId }) =>
      normalizeMatrixApproverId(target.to) === normalizedSenderId,
  });
}

const matrixExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: (params) => resolveMatrixAccount(params).config.execApprovals,
  resolveApprovers: getMatrixExecApprovalApprovers,
  normalizeSenderId: normalizeMatrixApproverId,
  isTargetRecipient: isMatrixExecApprovalTargetRecipient,
  matchesRequestAccount: (params) => {
    const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
    const boundAccountId = resolveApprovalRequestAccountId({
      cfg: params.cfg,
      request: params.request,
      channel: turnSourceChannel === "matrix" ? null : "matrix",
    });
    return (
      !boundAccountId ||
      !params.accountId ||
      normalizeAccountId(boundAccountId) === normalizeAccountId(params.accountId)
    );
  },
});

export const isMatrixExecApprovalClientEnabled = matrixExecApprovalProfile.isClientEnabled;
export const isMatrixExecApprovalApprover = matrixExecApprovalProfile.isApprover;
export const isMatrixExecApprovalAuthorizedSender = matrixExecApprovalProfile.isAuthorizedSender;
export const resolveMatrixExecApprovalTarget = matrixExecApprovalProfile.resolveTarget;
export const shouldHandleMatrixExecApprovalRequest = matrixExecApprovalProfile.shouldHandleRequest;
export const shouldSuppressLocalMatrixExecApprovalPrompt =
  matrixExecApprovalProfile.shouldSuppressLocalPrompt;
