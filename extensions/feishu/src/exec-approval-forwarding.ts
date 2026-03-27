import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildExecApprovalPendingReplyPayload,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/infra-runtime";
import { normalizeMessageChannel, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { compileSafeRegex, testRegexWithBoundedInput } from "openclaw/plugin-sdk/security-runtime";
import { createExecApprovalCard } from "./card-ux-exec-approval.js";
import {
  getFeishuExecApprovalApprovers,
  isFeishuExecApprovalClientEnabled,
  resolveFeishuExecApprovalConfig,
} from "./exec-approvals.js";

function matchesFeishuFilters(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ExecApprovalRequest;
}): boolean {
  const config = resolveFeishuExecApprovalConfig({ cfg: params.cfg, accountId: params.accountId });
  if (!config?.enabled) {
    return false;
  }
  if (
    getFeishuExecApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0
  ) {
    return false;
  }
  if (config.agentFilter?.length) {
    const agentId =
      params.request.request.agentId ??
      parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
    if (!agentId || !config.agentFilter.includes(agentId)) {
      return false;
    }
  }
  if (config.sessionFilter?.length) {
    const sessionKey = params.request.request.sessionKey;
    if (!sessionKey) {
      return false;
    }
    const matches = config.sessionFilter.some((pattern) => {
      if (sessionKey.includes(pattern)) {
        return true;
      }
      const regex = compileSafeRegex(pattern);
      return regex ? testRegexWithBoundedInput(regex, sessionKey) : false;
    });
    if (!matches) {
      return false;
    }
  }
  return true;
}

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
  return matchesFeishuFilters({ cfg: params.cfg, accountId, request: params.request });
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
