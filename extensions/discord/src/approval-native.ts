import {
  createApproverRestrictedNativeApprovalAdapter,
  resolveApprovalRequestOriginTarget,
} from "openclaw/plugin-sdk/approval-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
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

function resolveDiscordOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}) {
  const sessionKind = extractDiscordSessionKind(params.request.request.sessionKey?.trim() || null);
  return resolveApprovalRequestOriginTarget({
    cfg: params.cfg,
    request: params.request,
    channel: "discord",
    accountId: params.accountId,
    resolveTurnSourceTarget: (request) => {
      const turnSourceChannel = request.request.turnSourceChannel?.trim().toLowerCase() || "";
      const rawTurnSourceTo = request.request.turnSourceTo?.trim() || "";
      const turnSourceTo = normalizeDiscordOriginChannelId(rawTurnSourceTo);
      const hasExplicitOriginTarget = /^(?:channel|group):/i.test(rawTurnSourceTo);
      if (turnSourceChannel !== "discord" || !turnSourceTo || sessionKind === "dm") {
        return null;
      }
      return hasExplicitOriginTarget || sessionKind === "channel" || sessionKind === "group"
        ? { to: turnSourceTo }
        : null;
    },
    resolveSessionTarget: (sessionTarget) => {
      if (sessionKind === "dm") {
        return null;
      }
      const targetTo = normalizeDiscordOriginChannelId(sessionTarget.to);
      return targetTo ? { to: targetTo } : null;
    },
    targetsMatch: (a, b) => a.to === b.to,
    resolveFallbackTarget: (request) => {
      if (sessionKind === "dm") {
        return null;
      }
      const legacyChannelId = extractDiscordChannelId(request.request.sessionKey?.trim() || null);
      return legacyChannelId ? { to: legacyChannelId } : null;
    },
  });
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
