import {
  createApproverRestrictedNativeApprovalAdapter,
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestSessionTarget,
} from "openclaw/plugin-sdk/approval-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ExecApprovalRequest,
  ExecApprovalSessionTarget,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/infra-runtime";
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
  return resolveApprovalRequestSessionTarget(params);
}

function resolveDiscordOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}) {
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "discord",
      accountId: params.accountId,
    })
  ) {
    return null;
  }

  const sessionKind = extractDiscordSessionKind(params.request.request.sessionKey?.trim() || null);
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const rawTurnSourceTo = params.request.request.turnSourceTo?.trim() || "";
  const turnSourceTo = normalizeDiscordOriginChannelId(rawTurnSourceTo);
  const hasExplicitOriginTarget = /^(?:channel|group):/i.test(rawTurnSourceTo);
  const turnSourceTarget =
    turnSourceChannel === "discord" &&
    turnSourceTo &&
    sessionKind !== "dm" &&
    (hasExplicitOriginTarget || sessionKind === "channel" || sessionKind === "group")
      ? {
          to: turnSourceTo,
        }
      : null;

  const sessionTarget = resolveRequestSessionTarget(params);
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
