import {
  createChannelExecApprovalProfile,
  getExecApprovalReplyMetadata,
  isChannelExecApprovalTargetRecipient,
  resolveApprovalRequestAccountId,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export function normalizeMatrixApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixUserId(String(value));
  return normalized || undefined;
}

function normalizeMatrixExecApproverId(value: string | number): string | undefined {
  const normalized = normalizeMatrixApproverId(value);
  return normalized === "*" ? undefined : normalized;
}

function resolveMatrixExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const config = resolveMatrixAccount(params).config.execApprovals;
  if (!config) {
    return { enabled: false } as const;
  }
  return {
    ...config,
    enabled: config.enabled === true,
  };
}

export function getMatrixExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveMatrixAccount(params).config;
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers,
    allowFrom: account.dm?.allowFrom,
    normalizeApprover: normalizeMatrixExecApproverId,
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
  resolveConfig: resolveMatrixExecApprovalConfig,
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

function buildFilterCheckRequest(params: {
  approvalId: string;
  payload: ReplyPayload;
}): ExecApprovalRequest | null {
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata) {
    return null;
  }
  return {
    id: params.approvalId,
    request: {
      command: "",
      agentId: metadata.agentId ?? null,
      sessionKey: metadata.sessionKey ?? null,
    },
    createdAtMs: 0,
    expiresAtMs: 0,
  };
}

export function shouldSuppressLocalMatrixExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  if (!matrixExecApprovalProfile.shouldSuppressLocalPrompt(params)) {
    return false;
  }
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata) {
    return false;
  }
  const request = buildFilterCheckRequest({
    approvalId: metadata.approvalId,
    payload: params.payload,
  });
  if (!request) {
    return false;
  }
  return shouldHandleMatrixExecApprovalRequest({
    cfg: params.cfg,
    accountId: params.accountId,
    request,
  });
}
