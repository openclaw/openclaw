import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { resolveApprovalRequestChannelAccountId } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  OpenClawConfig,
  TelegramExecApprovalConfig,
} from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "./accounts.js";
import { resolveTelegramInlineButtonsConfigScope } from "./inline-buttons.js";
import { normalizeTelegramChatId, resolveTelegramTargetChatType } from "./targets.js";

function normalizeApproverId(value: string | number): string {
  return String(value).trim();
}

function normalizeTelegramDirectApproverId(value: string | number): string | undefined {
  const normalized = normalizeApproverId(value);
  const chatId = normalizeTelegramChatId(normalized);
  if (!chatId || chatId.startsWith("-")) {
    return undefined;
  }
  return chatId;
}

function resolveTelegramApprovalAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  return params.accountId
    ? normalizeAccountId(params.accountId)
    : resolveDefaultTelegramAccountId(params.cfg);
}

function resolveTelegramApprovalAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  return mergeTelegramAccountConfig(params.cfg, resolveTelegramApprovalAccountId(params));
}

export function resolveTelegramExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramExecApprovalConfig | undefined {
  const account = resolveTelegramApprovalAccountConfig(params);
  const config = account.execApprovals;
  if (!config) {
    return undefined;
  }
  return {
    ...config,
    enabled: account.enabled !== false && config.enabled !== false,
  };
}

export function getTelegramExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveTelegramApprovalAccountConfig(params);
  return resolveApprovalApprovers({
    explicit: resolveTelegramExecApprovalConfig(params)?.approvers,
    allowFrom: account.allowFrom,
    defaultTo: account.defaultTo ? String(account.defaultTo) : null,
    normalizeApprover: normalizeTelegramDirectApproverId,
  });
}

export function isTelegramExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "telegram",
    matchTarget: ({ target, normalizedSenderId }) => {
      const to = target.to ? normalizeTelegramChatId(target.to) : undefined;
      if (!to || to.startsWith("-")) {
        return false;
      }
      return to === normalizedSenderId;
    },
  });
}

function hasMatchingTelegramForwardTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const approvalKind = params.request.id.startsWith("plugin:") ? "plugin" : "exec";
  const forwardingCfg =
    approvalKind === "plugin" ? params.cfg.approvals?.plugin : params.cfg.approvals?.exec;
  if (!forwardingCfg?.enabled) {
    return false;
  }
  const mode = forwardingCfg.mode ?? "session";
  if (mode !== "targets" && mode !== "both") {
    return false;
  }
  if (
    !matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: forwardingCfg.agentFilter,
      sessionFilter: forwardingCfg.sessionFilter,
      fallbackAgentIdFromSessionKey: true,
    })
  ) {
    return false;
  }
  const expectedAccountId = params.accountId ? normalizeAccountId(params.accountId) : null;
  return (forwardingCfg.targets ?? []).some((target) => {
    if (target.channel?.trim().toLowerCase() !== "telegram") {
      return false;
    }
    if (!target.to?.trim()) {
      return false;
    }
    const targetAccountId = target.accountId ? normalizeAccountId(target.accountId) : null;
    if (expectedAccountId && targetAccountId && targetAccountId !== expectedAccountId) {
      return false;
    }
    return true;
  });
}

function countTelegramExecApprovalEligibleAccounts(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): number {
  return listTelegramAccountIds(params.cfg).filter((accountId) => {
    const resolvedAccount = resolveTelegramAccount({
      cfg: params.cfg,
      accountId,
    });
    if (!resolvedAccount.enabled || resolvedAccount.tokenSource === "none") {
      return false;
    }
    const config = resolveTelegramExecApprovalConfig({
      cfg: params.cfg,
      accountId,
    });
    return (
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: config?.enabled,
        approverCount: getTelegramExecApprovalApprovers({ cfg: params.cfg, accountId }).length,
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

function matchesTelegramRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest | PluginApprovalRequest;
}): boolean {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const boundAccountId = resolveApprovalRequestChannelAccountId({
    cfg: params.cfg,
    request: params.request,
    channel: "telegram",
  });
  if (turnSourceChannel && turnSourceChannel !== "telegram" && !boundAccountId) {
    if (
      hasMatchingTelegramForwardTarget({
        cfg: params.cfg,
        accountId: params.accountId,
        request: params.request,
      })
    ) {
      return false;
    }
    return (
      countTelegramExecApprovalEligibleAccounts({
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

const telegramExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveTelegramExecApprovalConfig,
  resolveApprovers: getTelegramExecApprovalApprovers,
  isTargetRecipient: isTelegramExecApprovalTargetRecipient,
  matchesRequestAccount: matchesTelegramRequestAccount,
  // Telegram session keys often carry the only stable agent ID for approval routing.
  fallbackAgentIdFromSessionKey: true,
  requireClientEnabledForLocalPromptSuppression: false,
});

export const isTelegramExecApprovalClientEnabled = telegramExecApprovalProfile.isClientEnabled;
export const isTelegramExecApprovalApprover = telegramExecApprovalProfile.isApprover;
export const isTelegramExecApprovalAuthorizedSender = isTelegramExecApprovalApprover;
export const resolveTelegramExecApprovalTarget = telegramExecApprovalProfile.resolveTarget;
export const shouldHandleTelegramExecApprovalRequest =
  telegramExecApprovalProfile.shouldHandleRequest;

export function shouldInjectTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean {
  if (!isTelegramExecApprovalClientEnabled(params)) {
    return false;
  }
  const target = resolveTelegramExecApprovalTarget(params);
  const chatType = resolveTelegramTargetChatType(params.to);
  if (chatType === "direct") {
    return target === "dm" || target === "both";
  }
  if (chatType === "group") {
    return target === "channel" || target === "both";
  }
  return target === "both";
}

function resolveExecApprovalButtonsExplicitlyDisabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const capabilities = resolveTelegramApprovalAccountConfig(params).capabilities;
  return resolveTelegramInlineButtonsConfigScope(capabilities) === "off";
}

export function shouldEnableTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean {
  if (!shouldInjectTelegramExecApprovalButtons(params)) {
    return false;
  }
  return !resolveExecApprovalButtonsExplicitlyDisabled(params);
}

export function shouldSuppressLocalTelegramExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return telegramExecApprovalProfile.shouldSuppressLocalPrompt(params);
}

export function isTelegramExecApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: resolveTelegramExecApprovalConfig(params)?.enabled,
    approverCount: getTelegramExecApprovalApprovers(params).length,
  });
}
