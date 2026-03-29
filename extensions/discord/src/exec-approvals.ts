import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
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

function collectDiscordInferredApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveDiscordAccount(params).config;
  const inferred = new Set<string>();
  for (const entry of [...(account.allowFrom ?? []), ...(account.dm?.allowFrom ?? [])]) {
    const approverId = normalizeDiscordApproverId(String(entry));
    if (approverId) {
      inferred.add(approverId);
    }
  }
  const defaultTo = account.defaultTo?.trim();
  if (defaultTo) {
    try {
      const target = parseDiscordTarget(defaultTo);
      if (target?.kind === "user") {
        inferred.add(target.id);
      }
    } catch {
      // Ignore ambiguous default targets; explicit approvers or allowFrom still work.
    }
  }
  return [...inferred];
}

export function getDiscordExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const config = resolveDiscordAccount(params).config.execApprovals;
  const explicit = (config?.approvers ?? [])
    .map((entry) => normalizeDiscordApproverId(String(entry)))
    .filter((entry): entry is string => Boolean(entry));
  if (explicit.length > 0) {
    return [...new Set(explicit)];
  }
  return collectDiscordInferredApprovers(params);
}

export function isDiscordExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveDiscordAccount(params).config.execApprovals;
  return Boolean(config?.enabled && getDiscordExecApprovalApprovers(params).length > 0);
}

export function isDiscordExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  return getDiscordExecApprovalApprovers(params).includes(senderId);
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
