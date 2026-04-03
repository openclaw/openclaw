import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  resolveApprovalApprovers,
  resolveApprovalRequestAccountId,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveFeishuAccount } from "./accounts.js";

type FeishuExecApprovalConfig = {
  enabled?: boolean;
  approvers?: Array<string | number>;
  agentFilter?: string[];
  sessionFilter?: string[];
  target?: "dm" | "channel" | "both";
};

function normalizeApproverId(value: string | number): string {
  return String(value).trim();
}

function normalizeFeishuDirectApproverId(value: string | number): string | undefined {
  const normalized = normalizeApproverId(value);
  if (!normalized) {
    return undefined;
  }
  // Feishu user IDs start with ou_ or on_
  return normalized;
}

export function resolveFeishuExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): FeishuExecApprovalConfig | undefined {
  const config = resolveFeishuAccount(params).config;
  return (config as Record<string, unknown>).execApprovals as FeishuExecApprovalConfig | undefined;
}

export function getFeishuExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return resolveApprovalApprovers({
    explicit: resolveFeishuExecApprovalConfig(params)?.approvers,
    normalizeApprover: normalizeFeishuDirectApproverId,
  });
}

export function isFeishuExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "feishu",
    matchTarget: ({ target, normalizedSenderId }) => {
      const to = target.to?.trim();
      if (!to) {
        return false;
      }
      // Strip "user:" prefix for DM targets
      const normalized = to.startsWith("user:") ? to.slice(5) : to;
      return normalized === normalizedSenderId;
    },
  });
}

const feishuExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveFeishuExecApprovalConfig,
  resolveApprovers: getFeishuExecApprovalApprovers,
  isTargetRecipient: isFeishuExecApprovalTargetRecipient,
  matchesRequestAccount: ({ cfg, accountId, request }) => {
    const boundAccountId = resolveApprovalRequestAccountId({
      cfg,
      request,
      channel:
        request.request.turnSourceChannel?.trim().toLowerCase() === "feishu" ? null : "feishu",
    });
    return (
      !boundAccountId ||
      !accountId ||
      normalizeAccountId(boundAccountId) === normalizeAccountId(accountId)
    );
  },
  fallbackAgentIdFromSessionKey: true,
  requireClientEnabledForLocalPromptSuppression: true,
});

export const isFeishuExecApprovalClientEnabled = feishuExecApprovalProfile.isClientEnabled;
export const isFeishuExecApprovalApprover = feishuExecApprovalProfile.isApprover;
export const isFeishuExecApprovalAuthorizedSender = feishuExecApprovalProfile.isAuthorizedSender;
export const resolveFeishuExecApprovalTarget = feishuExecApprovalProfile.resolveTarget;
export const shouldHandleFeishuExecApprovalRequest = feishuExecApprovalProfile.shouldHandleRequest;

export function shouldSuppressLocalFeishuExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return feishuExecApprovalProfile.shouldSuppressLocalPrompt(params);
}

export function isFeishuExecApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: resolveFeishuExecApprovalConfig(params)?.enabled,
    approverCount: getFeishuExecApprovalApprovers(params).length,
  });
}
