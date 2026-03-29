import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  resolveExecApprovalCommandDisplay,
  type ExecApprovalRequest,
} from "openclaw/plugin-sdk/exec-approval-runtime";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { buildTelegramExecApprovalButtons } from "./approval-buttons.js";
import { isTelegramExecApprovalClientEnabled } from "./exec-approvals.js";

export function shouldSuppressTelegramExecApprovalForwardingFallback(params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  request: ExecApprovalRequest;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (channel !== "telegram") {
    return false;
  }
  const requestChannel = normalizeMessageChannel(params.request.request.turnSourceChannel ?? "");
  if (requestChannel !== "telegram") {
    return false;
  }
  const accountId =
    params.target.accountId?.trim() || params.request.request.turnSourceAccountId?.trim();
  return isTelegramExecApprovalClientEnabled({ cfg: params.cfg, accountId });
}

export function buildTelegramExecApprovalPendingPayload(params: {
  request: ExecApprovalRequest;
  nowMs: number;
}) {
  const payload = buildExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id,
    command: resolveExecApprovalCommandDisplay(params.request.request).commandText,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
  });
  const buttons = buildTelegramExecApprovalButtons(params.request.id);
  if (!buttons) {
    return payload;
  }
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      telegram: { buttons },
    },
  };
}
