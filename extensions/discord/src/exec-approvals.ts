import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-runtime";
import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordExecApprovalConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { parseDiscordTarget } from "./targets.js";

function normalizeDiscordApproverId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const target = parseDiscordTarget(trimmed);
    return target?.kind === "user" ? target.id : undefined;
  } catch {
    return undefined;
  }
}

export function getDiscordExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): string[] {
  const account = resolveDiscordAccount(params).config;
  return resolveApprovalApprovers({
    explicit: params.configOverride?.approvers ?? account.execApprovals?.approvers,
    allowFrom: account.allowFrom,
    extraAllowFrom: account.dm?.allowFrom,
    defaultTo: account.defaultTo,
    normalizeApprover: (value) => normalizeDiscordApproverId(String(value)),
    normalizeDefaultTo: (value) => {
      try {
        const target = parseDiscordTarget(value);
        return target?.kind === "user" ? target.id : undefined;
      } catch {
        return undefined;
      }
    },
  });
}

export function isDiscordExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const config = params.configOverride ?? resolveDiscordAccount(params).config.execApprovals;
  return Boolean(
    config?.enabled &&
    getDiscordExecApprovalApprovers({
      cfg: params.cfg,
      accountId: params.accountId,
      configOverride: params.configOverride,
    }).length > 0,
  );
}

export function isDiscordExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  return getDiscordExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
    configOverride: params.configOverride,
  }).includes(senderId);
}

export function shouldSuppressLocalDiscordExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return (
    isDiscordExecApprovalClientEnabled(params) &&
    getExecApprovalReplyMetadata(params.payload) !== null
  );
}
