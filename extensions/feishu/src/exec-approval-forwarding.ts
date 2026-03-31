import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/infra-runtime";
import { createExecApprovalCard } from "./card-ux-exec-approval.js";
import {
  isFeishuExecApprovalClientEnabled,
  resolveFeishuExecApprovalTarget,
} from "./exec-approvals.js";

// Suppress forwarding to a specific target when the configured exec approval
// target routing (dm/channel/both) doesn't match the actual target chat type.
// This prevents both Interactive Cards AND plain-text fallback from leaking
// into excluded chats. Without a dedicated Feishu exec approval handler client,
// forwarding fallback is the only delivery path, so we only suppress targets
// that violate the routing config — never suppress all targets unconditionally.
export function shouldSuppressFeishuExecApprovalForwardingFallback(params: {
  cfg: OpenClawConfig;
  target: { channel: string; to: string; accountId?: string | null };
  request: ExecApprovalRequest;
}): boolean {
  if (!isFeishuExecApprovalClientEnabled({ cfg: params.cfg, accountId: params.target.accountId })) {
    return false;
  }
  const configuredTarget = resolveFeishuExecApprovalTarget({
    cfg: params.cfg,
    accountId: params.target.accountId,
  });
  if (configuredTarget === "both") {
    return false;
  }
  const isDm = isFeishuDmTarget(params.target.to);
  if (configuredTarget === "dm" && !isDm) {
    return true;
  }
  if (configuredTarget === "channel" && isDm) {
    return true;
  }
  return false;
}

// Determine whether a Feishu target address is a DM (user:*) or group (chat:*).
function isFeishuDmTarget(to: string): boolean {
  return to.startsWith("user:");
}

export function buildFeishuExecApprovalPendingPayload(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  target: { channel: string; to: string; accountId?: string | null };
  nowMs: number;
}) {
  // Defense-in-depth: if the configured target routing doesn't match this
  // specific forward target, return null so the framework falls back to
  // plain text instead of leaking an Interactive Card into an excluded chat.
  const configuredTarget = resolveFeishuExecApprovalTarget({
    cfg: params.cfg,
    accountId: params.target.accountId,
  });
  const isDm = isFeishuDmTarget(params.target.to);
  if (configuredTarget === "dm" && !isDm) {
    return null;
  }
  if (configuredTarget === "channel" && isDm) {
    return null;
  }

  const commandDisplay = resolveExecApprovalCommandDisplay(params.request.request);
  const payload = buildExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id,
    command: commandDisplay.commandText,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
  });

  const card = createExecApprovalCard({
    approvalId: params.request.id,
    command: commandDisplay.commandText,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    expiresAtMs: params.request.expiresAtMs,
  });

  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      feishu: { card },
    },
  };
}
