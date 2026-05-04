import {
  buildExecApprovalPendingReplyPayload,
  resolveExecApprovalRequestAllowedDecisions,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramInlineButtons, stackTelegramInlineButtons } from "./button-types.js";
import { isTelegramExecApprovalClientEnabled } from "./exec-approvals.js";

const log = createSubsystemLogger("telegram/exec-approval-forwarding");

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

function buildTelegramExecApprovalBasePendingPayload(params: {
  request: ExecApprovalRequest;
  nowMs: number;
  includeManualApprovalInstructions: boolean;
}) {
  return buildExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id.slice(0, 8),
    command: resolveExecApprovalCommandDisplay(params.request.request).commandText,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
    includeManualApprovalInstructions: params.includeManualApprovalInstructions,
  });
}

export function buildTelegramExecApprovalPendingPayload(params: {
  request: ExecApprovalRequest;
  nowMs: number;
}) {
  const manualPayload = buildTelegramExecApprovalBasePendingPayload({
    ...params,
    includeManualApprovalInstructions: true,
  });
  const buttons = stackTelegramInlineButtons(
    resolveTelegramInlineButtons({ interactive: manualPayload.interactive }),
  );
  if (!buttons) {
    log.warn(
      "telegram exec approval forwarding: falling back to manual approval text because no inline approval buttons were generated",
    );
    return manualPayload;
  }
  const buttonPayload = buildTelegramExecApprovalBasePendingPayload({
    ...params,
    includeManualApprovalInstructions: false,
  });

  return {
    ...buttonPayload,
    channelData: {
      ...(buttonPayload.channelData ?? {}),
      telegram: {
        buttons,
      },
    },
  };
}
