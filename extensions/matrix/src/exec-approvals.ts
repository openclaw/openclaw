import {
  createChannelExecApprovalProfile,
  getExecApprovalReplyMetadata,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  matchesApprovalRequestFilters,
  resolveApprovalRequestChannelAccountId,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { listMatrixAccountIds, resolveMatrixAccount } from "./matrix/accounts.js";
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
  const account = resolveMatrixAccount(params);
  const config = account.config.execApprovals;
  if (!config) {
    return { enabled: false } as const;
  }
  return {
    ...config,
    enabled: account.enabled && account.configured && config.enabled === true,
  };
}

function countMatrixExecApprovalEligibleAccounts(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequest;
}): number {
  return listMatrixAccountIds(params.cfg).filter((accountId) => {
    const account = resolveMatrixAccount({ cfg, accountId });
    if (!account.enabled || !account.configured) {
      return false;
    }
    const config = resolveMatrixExecApprovalConfig({
      cfg: params.cfg,
      accountId,
    });
    return (
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: config.enabled,
        approverCount: getMatrixExecApprovalApprovers({ cfg: params.cfg, accountId }).length,
      }) &&
      matchesApprovalRequestFilters({
        request: params.request.request,
        agentFilter: config.agentFilter,
        sessionFilter: config.sessionFilter,
      })
    );
  }).length;
}

function matchesMatrixRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const boundAccountId = resolveApprovalRequestChannelAccountId({
    cfg: params.cfg,
    request: params.request,
    channel: "matrix",
  });
  if (turnSourceChannel && turnSourceChannel !== "matrix" && !boundAccountId) {
    return (
      countMatrixExecApprovalEligibleAccounts({
        cfg: params.cfg,
        request: params.request,
      }) <= 1
    );
  }
  return (
    !boundAccountId ||
    !params.accountId ||
    normalizeAccountId(boundAccountId) === normalizeAccountId(params.accountId)
  );
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
  matchesRequestAccount: matchesMatrixRequestAccount,
});

export const isMatrixExecApprovalClientEnabled = matrixExecApprovalProfile.isClientEnabled;
export const isMatrixExecApprovalApprover = matrixExecApprovalProfile.isApprover;
export const isMatrixExecApprovalAuthorizedSender = matrixExecApprovalProfile.isAuthorizedSender;
export const resolveMatrixExecApprovalTarget = matrixExecApprovalProfile.resolveTarget;
export const shouldHandleMatrixExecApprovalRequest = matrixExecApprovalProfile.shouldHandleRequest;

function buildFilterCheckRequest(params: {
  metadata: NonNullable<ReturnType<typeof getExecApprovalReplyMetadata>>;
}): ExecApprovalRequest {
  return {
    id: params.metadata.approvalId,
    request: {
      command: "",
      agentId: params.metadata.agentId ?? null,
      sessionKey: params.metadata.sessionKey ?? null,
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
  if (metadata.approvalKind !== "exec") {
    return false;
  }
  const request = buildFilterCheckRequest({
    metadata,
  });
  return shouldHandleMatrixExecApprovalRequest({
    cfg: params.cfg,
    accountId: params.accountId,
    request,
  });
}
