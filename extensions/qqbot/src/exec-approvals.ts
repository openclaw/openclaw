import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { resolveApprovalRequestChannelAccountId } from "openclaw/plugin-sdk/approval-native-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { listQQBotAccountIds, resolveQQBotAccount } from "./config.js";
import type { QQBotExecApprovalConfig } from "./types.js";

function normalizeApproverId(value: string | number): string | undefined {
  const trimmed = normalizeOptionalString(String(value));
  return trimmed || undefined;
}

export function resolveQQBotExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): QQBotExecApprovalConfig | undefined {
  const account = resolveQQBotAccount(params.cfg, params.accountId);
  const config = account.config.execApprovals;
  if (!config) {
    return undefined;
  }
  return {
    ...config,
    enabled: account.enabled && account.secretSource !== "none" ? config.enabled : false,
  };
}

export function getQQBotExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const accountConfig = resolveQQBotAccount(params.cfg, params.accountId).config;
  return resolveApprovalApprovers({
    explicit: resolveQQBotExecApprovalConfig(params)?.approvers,
    allowFrom: accountConfig.allowFrom,
    normalizeApprover: normalizeApproverId,
  });
}

function countQQBotExecApprovalEligibleAccounts(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): number {
  return listQQBotAccountIds(params.cfg).filter((accountId) => {
    const account = resolveQQBotAccount(params.cfg, accountId);
    if (!account.enabled || account.secretSource === "none") {
      return false;
    }
    const config = resolveQQBotExecApprovalConfig({
      cfg: params.cfg,
      accountId,
    });
    return (
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: config?.enabled,
        approverCount: getQQBotExecApprovalApprovers({ cfg: params.cfg, accountId }).length,
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

function matchesQQBotRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(
    params.request.request.turnSourceChannel,
  );
  const boundAccountId = resolveApprovalRequestChannelAccountId({
    cfg: params.cfg,
    request: params.request,
    channel: "qqbot",
  });
  if (turnSourceChannel && turnSourceChannel !== "qqbot" && !boundAccountId) {
    return (
      countQQBotExecApprovalEligibleAccounts({
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

const qqbotExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveQQBotExecApprovalConfig,
  resolveApprovers: getQQBotExecApprovalApprovers,
  matchesRequestAccount: matchesQQBotRequestAccount,
  fallbackAgentIdFromSessionKey: true,
  requireClientEnabledForLocalPromptSuppression: false,
});

export const isQQBotExecApprovalClientEnabled = qqbotExecApprovalProfile.isClientEnabled;
export const isQQBotExecApprovalApprover = qqbotExecApprovalProfile.isApprover;
export const isQQBotExecApprovalAuthorizedSender = qqbotExecApprovalProfile.isAuthorizedSender;
export const resolveQQBotExecApprovalTarget = qqbotExecApprovalProfile.resolveTarget;
export const shouldHandleQQBotExecApprovalRequest = qqbotExecApprovalProfile.shouldHandleRequest;

export function isQQBotExecApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: resolveQQBotExecApprovalConfig(params)?.enabled,
    approverCount: getQQBotExecApprovalApprovers(params).length,
  });
}
