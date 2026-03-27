import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/infra-runtime";
import { createExecApprovalCard } from "./card-ux-exec-approval.js";

// Unlike Telegram (which has an independent TelegramExecApprovalHandler gateway
// client to take over delivery), Feishu currently delivers exec approval cards
// only via the forwarding fallback pipeline. Suppressing the fallback would
// remove the only delivery route, causing approval requests to expire silently
// with "no-approval-route". Always return false until a dedicated Feishu exec
// approval handler client is implemented.
export function shouldSuppressFeishuExecApprovalForwardingFallback(_params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  request: ExecApprovalRequest;
}): boolean {
  return false;
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
