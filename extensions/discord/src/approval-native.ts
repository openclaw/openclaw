import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { listDiscordAccountIds, resolveDiscordAccount } from "./accounts.js";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createApproverRestrictedNativeApprovalCapability,
  splitChannelApprovalCapability,
  doesApprovalRequestMatchChannelAccount,
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "./approval-runtime.js";
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

export function shouldHandleDiscordApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const config =
    params.configOverride ??
    resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId }).config.execApprovals;
  const approvers = getDiscordExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
    configOverride: params.configOverride,
  });
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: "discord",
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: approvers.length,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
  });
}

function createDiscordOriginTargetResolver(configOverride?: DiscordExecApprovalConfig | null) {
  return createChannelNativeOriginTargetResolver({
    channel: "discord",
    shouldHandleRequest: ({ cfg, accountId, request }) =>
      shouldHandleDiscordApprovalRequest({
        cfg,
        accountId,
        request,
        configOverride,
      }),
    resolveTurnSourceTarget: (request) => {
      const sessionKind = extractDiscordSessionKind(request.request.sessionKey?.trim() || null);
      const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
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
    resolveSessionTarget: (sessionTarget, request) => {
      const sessionKind = extractDiscordSessionKind(request.request.sessionKey?.trim() || null);
      if (sessionKind === "dm") {
        return null;
      }
      const targetTo = normalizeDiscordOriginChannelId(sessionTarget.to);
      return targetTo ? { to: targetTo } : null;
    },
    targetsMatch: (a, b) => a.to === b.to,
    resolveFallbackTarget: (request) => {
      const sessionKind = extractDiscordSessionKind(request.request.sessionKey?.trim() || null);
      if (sessionKind === "dm") {
        return null;
      }
      const legacyChannelId = extractDiscordChannelId(request.request.sessionKey?.trim() || null);
      return legacyChannelId ? { to: legacyChannelId } : null;
    },
  });
}

function createDiscordApproverDmTargetResolver(configOverride?: DiscordExecApprovalConfig | null) {
  return createChannelApproverDmTargetResolver({
    shouldHandleRequest: ({ cfg, accountId, request }) =>
      shouldHandleDiscordApprovalRequest({
        cfg,
        accountId,
        request,
        configOverride,
      }),
    resolveApprovers: ({ cfg, accountId }) =>
      getDiscordExecApprovalApprovers({ cfg, accountId, configOverride }),
    mapApprover: (approver) => ({ to: String(approver) }),
  });
}

export function createDiscordApprovalCapability(configOverride?: DiscordExecApprovalConfig | null) {
  return createApproverRestrictedNativeApprovalCapability({
    channel: "discord",
    channelLabel: "Discord",
    describeExecApprovalSetup: ({ accountId }) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.discord.accounts.${accountId}`
          : "channels.discord";
      return `Approve it from the Web UI or terminal UI for now. Discord supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
    },
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
    resolveOriginTarget: createDiscordOriginTargetResolver(configOverride),
    resolveApproverDmTargets: createDiscordApproverDmTargetResolver(configOverride),
    notifyOriginWhenDmOnly: true,
  });
}

export function createDiscordNativeApprovalAdapter(
  configOverride?: DiscordExecApprovalConfig | null,
) {
  return splitChannelApprovalCapability(createDiscordApprovalCapability(configOverride));
}

let cachedDiscordApprovalCapability: ReturnType<typeof createDiscordApprovalCapability> | undefined;
let cachedDiscordNativeApprovalAdapter:
  | ReturnType<typeof createDiscordNativeApprovalAdapter>
  | undefined;

export function getDiscordApprovalCapability() {
  cachedDiscordApprovalCapability ??= createDiscordApprovalCapability();
  return cachedDiscordApprovalCapability;
}

export function getDiscordNativeApprovalAdapter() {
  cachedDiscordNativeApprovalAdapter ??= createDiscordNativeApprovalAdapter();
  return cachedDiscordNativeApprovalAdapter;
}
