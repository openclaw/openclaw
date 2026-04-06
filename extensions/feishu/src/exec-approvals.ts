import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  matchesApprovalRequestFilters,
  resolveApprovalApprovers,
  resolveApprovalRequestChannelAccountId,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { listFeishuAccountIds, resolveFeishuAccount } from "./accounts.js";
import { parseFeishuDirectConversationId } from "./conversation-id.js";

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
  // Parse through prefixed forms (user:ou_xxx, feishu:user:ou_xxx, etc.)
  // then validate that the resolved ID is an ou_ open_id — the identifier
  // used in Feishu card action callbacks (event.operator.open_id).
  const parsed = parseFeishuDirectConversationId(value);
  if (parsed) {
    return parsed;
  }
  // Also accept bare ou_ IDs
  const raw = String(value).trim();
  if (raw.startsWith("ou_")) {
    return raw;
  }
  return undefined;
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
  const account = resolveFeishuAccount(params).config;
  return resolveApprovalApprovers({
    explicit: resolveFeishuExecApprovalConfig(params)?.approvers,
    allowFrom: (account as Record<string, unknown>).allowFrom as Array<string | number> | undefined,
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
      // Use the same parser as approver normalization to handle all
      // Feishu address forms (user:ou_xxx, dm:ou_xxx, open_id:ou_xxx,
      // feishu:user:ou_xxx, bare ou_xxx).
      const parsed = parseFeishuDirectConversationId(target.to);
      if (!parsed) {
        return false;
      }
      return parsed === normalizedSenderId;
    },
  });
}

function countFeishuExecApprovalEligibleAccounts(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): number {
  return listFeishuAccountIds(params.cfg).filter((accountId) => {
    const account = resolveFeishuAccount({ cfg: params.cfg, accountId });
    if (!account.enabled || !account.configured) {
      return false;
    }
    const config = resolveFeishuExecApprovalConfig({ cfg: params.cfg, accountId });
    return (
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: config?.enabled,
        approverCount: getFeishuExecApprovalApprovers({ cfg: params.cfg, accountId }).length,
      }) &&
      matchesApprovalRequestFilters({
        request: params.request.request,
        agentFilter: config?.agentFilter,
        sessionFilter: config?.sessionFilter,
        fallbackAgentIdFromSessionKey: true,
      })
    );
  }).length;
}

function matchesFeishuRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const boundAccountId = resolveApprovalRequestChannelAccountId({
    cfg: params.cfg,
    request: params.request,
    channel: "feishu",
  });
  // For non-Feishu turn sources with no bound account, only handle if there
  // is exactly one eligible Feishu account to avoid duplicate prompts.
  if (turnSourceChannel && turnSourceChannel !== "feishu" && !boundAccountId) {
    return (
      countFeishuExecApprovalEligibleAccounts({
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

const feishuExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveFeishuExecApprovalConfig,
  resolveApprovers: getFeishuExecApprovalApprovers,
  isTargetRecipient: isFeishuExecApprovalTargetRecipient,
  matchesRequestAccount: matchesFeishuRequestAccount,
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
