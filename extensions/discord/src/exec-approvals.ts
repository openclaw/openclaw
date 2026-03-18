import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  getExecApprovalReplyMetadata,
} from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveDiscordAccount } from "./accounts.js";

function normalizeExecApprovalTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export function isDiscordExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveDiscordAccount(params).config.execApprovals;
  return Boolean(config?.enabled && (config.approvers?.length ?? 0) > 0);
}

export function resolveDiscordExecApprovalTimeoutMs(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  defaultTimeoutMs?: number;
}): number {
  const fallback = normalizeExecApprovalTimeoutMs(
    params.defaultTimeoutMs,
    DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  );
  if (!isDiscordExecApprovalClientEnabled(params)) {
    return fallback;
  }
  return normalizeExecApprovalTimeoutMs(
    resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId }).config.execApprovals
      ?.timeoutMs,
    fallback,
  );
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
