import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  resolveApprovalRequestChannelAccountId,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramExecApprovalConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
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

export function resolveTelegramExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramExecApprovalConfig | undefined {
  return resolveTelegramAccount(params).config.execApprovals;
}

export function getTelegramExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveTelegramAccount(params).config;
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

function countTelegramExecApprovalHandlerAccounts(cfg: OpenClawConfig): number {
  return listTelegramAccountIds(cfg).filter((accountId) => {
    const account = resolveTelegramAccount({ cfg, accountId });
    if (!account.enabled || account.tokenSource === "none") {
      return false;
    }
    return isChannelExecApprovalClientEnabledFromConfig({
      enabled: resolveTelegramExecApprovalConfig({ cfg, accountId })?.enabled,
      approverCount: getTelegramExecApprovalApprovers({ cfg, accountId }).length,
    });
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
    return countTelegramExecApprovalHandlerAccounts(params.cfg) <= 1;
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
export const isTelegramExecApprovalAuthorizedSender =
  telegramExecApprovalProfile.isAuthorizedSender;
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
  const capabilities = resolveTelegramAccount(params).config.capabilities;
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
