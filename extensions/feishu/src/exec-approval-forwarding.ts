import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/infra-runtime";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { createExecApprovalCard } from "./card-ux-exec-approval.js";
import { isFeishuExecApprovalClientEnabled } from "./exec-approvals.js";

export function shouldSuppressFeishuExecApprovalForwardingFallback(params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  request: ExecApprovalRequest;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (channel !== "feishu") {
    return false;
  }
  const requestChannel = normalizeMessageChannel(params.request.request.turnSourceChannel ?? "");
  if (requestChannel !== "feishu") {
    return false;
  }
  const accountId =
    params.target.accountId?.trim() || params.request.request.turnSourceAccountId?.trim();
  return isFeishuExecApprovalClientEnabled({ cfg: params.cfg, accountId });
}

export function buildFeishuExecApprovalPendingPayload(params: {
  request: ExecApprovalRequest;
  nowMs: number;
}) {
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
