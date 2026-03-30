import { createApproverRestrictedNativeApprovalAdapter } from "openclaw/plugin-sdk/approval-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalSessionTarget,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/infra-runtime";
import { resolveExecApprovalSessionTarget } from "openclaw/plugin-sdk/approval-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { listDiscordAccountIds, resolveDiscordAccount } from "./accounts.js";
import {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
} from "./exec-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export function extractDiscordChannelId(sessionKey?: string | null): string | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/discord:(?:channel|group):(\d+)/);
  return match ? match[1] : null;
}

function isExecApprovalRequest(request: ApprovalRequest): request is ExecApprovalRequest {
  return "command" in request.request;
}

function toExecLikeRequest(request: ApprovalRequest): ExecApprovalRequest {
  if (isExecApprovalRequest(request)) {
    return request;
  }
  return {
    id: request.id,
    request: {
      command: request.request.title,
      sessionKey: request.request.sessionKey ?? undefined,
      turnSourceChannel: request.request.turnSourceChannel ?? undefined,
      turnSourceTo: request.request.turnSourceTo ?? undefined,
      turnSourceAccountId: request.request.turnSourceAccountId ?? undefined,
    },
    createdAtMs: request.createdAtMs,
    expiresAtMs: request.expiresAtMs,
  };
}

function normalizeDiscordOriginChannelId(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const prefixed = trimmed.match(/^(?:channel|group):(\d+)$/i);
  if (prefixed) {
    return prefixed[1];
  }
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function resolveRequestSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequest;
}): ExecApprovalSessionTarget | null {
  const execLikeRequest = toExecLikeRequest(params.request);
  return resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: execLikeRequest,
    turnSourceChannel: execLikeRequest.request.turnSourceChannel ?? undefined,
    turnSourceTo: execLikeRequest.request.turnSourceTo ?? undefined,
    turnSourceAccountId: execLikeRequest.request.turnSourceAccountId ?? undefined,
  });
}

function resolveDiscordOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}) {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = normalizeDiscordOriginChannelId(params.request.request.turnSourceTo);
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
  if (turnSourceChannel === "discord" && turnSourceTo) {
    if (
      params.accountId &&
      turnSourceAccountId &&
      normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(params.accountId)
    ) {
      return null;
    }
    return { to: turnSourceTo };
  }

  const sessionTarget = resolveRequestSessionTarget(params);
  if (!sessionTarget || sessionTarget.channel !== "discord") {
    const channelId = extractDiscordChannelId(params.request.request.sessionKey?.trim() || null);
    return channelId ? { to: channelId } : null;
  }
  if (
    params.accountId &&
    sessionTarget.accountId &&
    normalizeAccountId(sessionTarget.accountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  const targetTo = normalizeDiscordOriginChannelId(sessionTarget.to);
  return targetTo ? { to: targetTo } : null;
}

function resolveDiscordApproverDmTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}) {
  return getDiscordExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
    configOverride: params.configOverride,
  }).map((approver) => ({ to: String(approver) }));
}

export function createDiscordNativeApprovalAdapter(
  configOverride?: DiscordExecApprovalConfig | null,
) {
  return createApproverRestrictedNativeApprovalAdapter({
    channel: "discord",
    channelLabel: "Discord",
    listAccountIds: listDiscordAccountIds,
    hasApprovers: ({ cfg, accountId }) =>
      getDiscordExecApprovalApprovers({ cfg, accountId, configOverride }).length > 0,
    isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
      isDiscordExecApprovalApprover({ cfg, accountId, senderId, configOverride }),
    isNativeDeliveryEnabled: ({ cfg, accountId }) =>
      isDiscordExecApprovalClientEnabled({ cfg, accountId, configOverride }),
    resolveNativeDeliveryMode: ({ cfg, accountId }) =>
      configOverride?.target ??
      resolveDiscordAccount({ cfg, accountId }).config.execApprovals?.target ??
      "dm",
    resolveOriginTarget: ({ cfg, accountId, request }) =>
      resolveDiscordOriginTarget({ cfg, accountId, request }),
    resolveApproverDmTargets: ({ cfg, accountId }) =>
      resolveDiscordApproverDmTargets({ cfg, accountId, configOverride }),
    notifyOriginWhenDmOnly: true,
  });
}

export const discordNativeApprovalAdapter = createDiscordNativeApprovalAdapter();
