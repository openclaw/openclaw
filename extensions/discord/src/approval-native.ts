import { createApproverRestrictedNativeApprovalAdapter } from "openclaw/plugin-sdk/approval-runtime";
import { resolveExecApprovalSessionTarget } from "openclaw/plugin-sdk/approval-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalSessionTarget,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/infra-runtime";
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

function extractDiscordSessionKind(sessionKey?: string | null): "channel" | "group" | "dm" | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/discord:(channel|group|dm):/);
  if (!match) {
    return null;
  }
  return match[1] as "channel" | "group" | "dm";
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
      turnSourceThreadId: request.request.turnSourceThreadId ?? undefined,
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
    turnSourceThreadId: execLikeRequest.request.turnSourceThreadId ?? undefined,
  });
}

function resolveDiscordOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}) {
  const sessionKind = extractDiscordSessionKind(params.request.request.sessionKey?.trim() || null);
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const rawTurnSourceTo = params.request.request.turnSourceTo?.trim() || "";
  const turnSourceTo = normalizeDiscordOriginChannelId(rawTurnSourceTo);
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
  const hasExplicitOriginTarget = /^(?:channel|group):/i.test(rawTurnSourceTo);
  const turnSourceTarget =
    turnSourceChannel === "discord" &&
    turnSourceTo &&
    sessionKind !== "dm" &&
    (hasExplicitOriginTarget || sessionKind === "channel" || sessionKind === "group")
      ? {
          to: turnSourceTo,
          accountId: turnSourceAccountId || undefined,
        }
      : null;
  if (
    turnSourceTarget?.accountId &&
    params.accountId &&
    normalizeAccountId(turnSourceTarget.accountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }

  const sessionTarget = resolveRequestSessionTarget(params);
  if (
    sessionTarget?.channel === "discord" &&
    sessionTarget.accountId &&
    params.accountId &&
    normalizeAccountId(sessionTarget.accountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  if (
    turnSourceTarget &&
    sessionTarget?.channel === "discord" &&
    turnSourceTarget.to !== normalizeDiscordOriginChannelId(sessionTarget.to)
  ) {
    return null;
  }

  if (turnSourceTarget) {
    return { to: turnSourceTarget.to };
  }
  if (sessionKind === "dm") {
    return null;
  }
  if (sessionTarget?.channel === "discord") {
    const targetTo = normalizeDiscordOriginChannelId(sessionTarget.to);
    return targetTo ? { to: targetTo } : null;
  }
  const legacyChannelId = extractDiscordChannelId(
    params.request.request.sessionKey?.trim() || null,
  );
  if (legacyChannelId) {
    return { to: legacyChannelId };
  }
  return null;
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
