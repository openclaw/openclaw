import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveSlackAccount } from "./accounts.js";
import type { OpenClawConfig, SlackAccountConfig } from "./runtime-api.js";

type SlackExecApprovalConfig = NonNullable<SlackAccountConfig["execApprovals"]>;

export function resolveSlackExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): SlackExecApprovalConfig | undefined {
  return resolveSlackAccount(params).config.execApprovals;
}

export function getSlackExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return (resolveSlackExecApprovalConfig(params)?.approvers ?? [])
    .map((id) => String(id).trim())
    .filter(Boolean);
}

export function isSlackExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveSlackExecApprovalConfig(params);
  return Boolean(config?.enabled && getSlackExecApprovalApprovers(params).length > 0);
}

export function isSlackExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  const approvers = getSlackExecApprovalApprovers(params);
  return approvers.includes(senderId);
}

export function resolveSlackExecApprovalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): "dm" | "channel" | "both" {
  return resolveSlackExecApprovalConfig(params)?.target ?? "dm";
}

export function shouldSuppressLocalSlackExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return (
    isSlackExecApprovalClientEnabled(params) &&
    getExecApprovalReplyMetadata(params.payload) !== null
  );
}
