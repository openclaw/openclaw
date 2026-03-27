import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
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
  return (resolveFeishuExecApprovalConfig(params)?.approvers ?? [])
    .map(normalizeApproverId)
    .filter(Boolean);
}

export function isFeishuExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveFeishuExecApprovalConfig(params);
  return Boolean(config?.enabled && getFeishuExecApprovalApprovers(params).length > 0);
}

export function isFeishuExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  const approvers = getFeishuExecApprovalApprovers(params);
  return approvers.includes(senderId);
}

export function resolveFeishuExecApprovalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): "dm" | "channel" | "both" {
  return resolveFeishuExecApprovalConfig(params)?.target ?? "dm";
}

export function shouldSuppressLocalFeishuExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return (
    isFeishuExecApprovalClientEnabled(params) &&
    getExecApprovalReplyMetadata(params.payload) !== null
  );
}
