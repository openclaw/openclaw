import {
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveSlackAccount } from "./accounts.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export function normalizeSlackApproverId(value: string | number): string | undefined {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return undefined;
  }
  const prefixed = trimmed.match(/^(?:slack|user):([A-Z0-9]+)$/i);
  if (prefixed?.[1]) {
    return prefixed[1];
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention?.[1]) {
    return mention[1];
  }
  return /^[UW][A-Z0-9]+$/i.test(trimmed) ? trimmed : undefined;
}

function matchesSlackApprovalSessionFilter(sessionKey: string, patterns: string[]): boolean {
  const boundedSessionKey = sessionKey.slice(0, 2048);
  return patterns.some((pattern) => {
    if (boundedSessionKey.includes(pattern)) {
      return true;
    }
    try {
      return new RegExp(pattern).test(boundedSessionKey);
    } catch {
      return false;
    }
  });
}

export function shouldHandleSlackExecApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "slack",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  const config = resolveSlackAccount(params).config.execApprovals;
  if (!config?.enabled) {
    return false;
  }
  if (getSlackExecApprovalApprovers(params).length === 0) {
    return false;
  }
  if (config.agentFilter?.length) {
    const agentId = params.request.request.agentId?.trim();
    if (!agentId || !config.agentFilter.includes(agentId)) {
      return false;
    }
  }
  if (config.sessionFilter?.length) {
    const sessionKey = params.request.request.sessionKey?.trim();
    if (!sessionKey || !matchesSlackApprovalSessionFilter(sessionKey, config.sessionFilter)) {
      return false;
    }
  }
  return true;
}

export function getSlackExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveSlackAccount(params).config;
  return resolveApprovalApprovers({
    explicit: account.execApprovals?.approvers,
    allowFrom: account.allowFrom,
    extraAllowFrom: account.dm?.allowFrom,
    defaultTo: account.defaultTo,
    normalizeApprover: normalizeSlackApproverId,
    normalizeDefaultTo: normalizeSlackApproverId,
  });
}

export function isSlackExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveSlackAccount(params).config.execApprovals;
  return Boolean(config?.enabled && getSlackExecApprovalApprovers(params).length > 0);
}

export function isSlackExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId ? normalizeSlackApproverId(params.senderId) : undefined;
  if (!senderId) {
    return false;
  }
  return getSlackExecApprovalApprovers(params).includes(senderId);
}

function isSlackExecApprovalTargetsMode(cfg: OpenClawConfig): boolean {
  const execApprovals = cfg.approvals?.exec;
  if (!execApprovals?.enabled) {
    return false;
  }
  return execApprovals.mode === "targets" || execApprovals.mode === "both";
}

export function isSlackExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  const senderId = params.senderId ? normalizeSlackApproverId(params.senderId) : undefined;
  if (!senderId || !isSlackExecApprovalTargetsMode(params.cfg)) {
    return false;
  }
  const targets = params.cfg.approvals?.exec?.targets;
  if (!targets) {
    return false;
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  return targets.some((target) => {
    if (target.channel?.trim().toLowerCase() !== "slack") {
      return false;
    }
    if (accountId && target.accountId && normalizeAccountId(target.accountId) !== accountId) {
      return false;
    }
    return normalizeSlackApproverId(target.to) === senderId;
  });
}

export function isSlackExecApprovalAuthorizedSender(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  return isSlackExecApprovalApprover(params) || isSlackExecApprovalTargetRecipient(params);
}

export function resolveSlackExecApprovalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): "dm" | "channel" | "both" {
  return resolveSlackAccount(params).config.execApprovals?.target ?? "dm";
}

export function shouldSuppressLocalSlackExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  void params;
  // Slack still uses the generic local pending-reply path. Unlike Discord and
  // Telegram, there is no Slack runtime handler that sends a replacement native
  // approval prompt via resolveChannelNativeApprovalDeliveryPlan, so suppressing
  // the local payload can hide the only visible approval prompt.
  return false;
}
