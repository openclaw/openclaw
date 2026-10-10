import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  resolveApprovalRequestSessionConversation,
  type ExecApprovalSessionTarget,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listDiscordAccountIds, resolveDiscordAccount } from "./accounts.js";
import { shouldHandleDiscordApprovalRequest } from "./approval-shared.js";
import {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
} from "./exec-approvals.js";

function shouldHandleCapabilityRequest({
  cfg,
  accountId,
  request,
}: Parameters<typeof shouldHandleDiscordApprovalRequest>[0]) {
  return shouldHandleDiscordApprovalRequest({ cfg, accountId, request });
}

function extractDiscordSessionKind(sessionKey?: string | null): "channel" | "group" | "dm" | null {
  if (!sessionKey) {
    return null;
  }
  // DM session keys use the `direct` peer kind in the normalized form
  // (`agent:<id>:discord[:account]:direct:<userId>`); legacy keys may still use
  // `dm`. Treat both as the same logical kind for downstream comparisons.
  const raw = sessionKey.match(/discord:(?:[^:]+:)?(channel|group|dm|direct):/)?.[1];
  if (raw === "direct") {
    return "dm";
  }
  return raw === "channel" || raw === "group" || raw === "dm" ? raw : null;
}

function normalizeDiscordOriginChannelId(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const prefixed = trimmed.match(/^(?:channel|group):(\d+)$/i);
  if (prefixed) {
    return prefixed[1] ?? null;
  }
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function normalizeDiscordThreadId(value?: string | number | null): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

function createDiscordOriginTargetResolver() {
  const resolveConversation = (
    request: Parameters<typeof resolveApprovalRequestSessionConversation>[0]["request"],
  ) =>
    resolveApprovalRequestSessionConversation({
      request,
      channel: "discord",
      bundledFallback: false,
    });
  const resolveSessionOrigin = (
    request: Parameters<typeof resolveConversation>[0],
    sessionTarget?: ExecApprovalSessionTarget,
  ) => {
    const sessionConversation = resolveConversation(request);
    const sessionKind = extractDiscordSessionKind(request.request.sessionKey?.trim() || null);
    if (sessionKind === "dm") {
      return null;
    }
    const to = normalizeDiscordOriginChannelId(
      sessionTarget ? sessionTarget.to : sessionConversation?.id,
    );
    return to
      ? {
          to,
          threadId:
            (sessionTarget ? normalizeDiscordThreadId(sessionTarget.threadId) : undefined) ??
            normalizeDiscordThreadId(sessionConversation?.threadId),
        }
      : null;
  };
  return createChannelNativeOriginTargetResolver({
    channel: "discord",
    shouldHandleRequest: shouldHandleCapabilityRequest,
    resolveTurnSourceTarget: (request) => {
      const sessionConversation = resolveConversation(request);
      const sessionKind = extractDiscordSessionKind(
        normalizeOptionalString(request.request.sessionKey) ?? null,
      );
      const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
      const rawTurnSourceTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
      const turnSourceTo = normalizeDiscordOriginChannelId(rawTurnSourceTo);
      const threadId =
        normalizeDiscordThreadId(request.request.turnSourceThreadId) ??
        normalizeDiscordThreadId(sessionConversation?.threadId);
      const hasExplicitOriginTarget = /^(?:channel|group):/i.test(rawTurnSourceTo);
      if (turnSourceChannel !== "discord" || !turnSourceTo || sessionKind === "dm") {
        return null;
      }
      return hasExplicitOriginTarget || sessionKind === "channel" || sessionKind === "group"
        ? { to: turnSourceTo, threadId }
        : null;
    },
    resolveSessionTarget: (sessionTarget, request) => resolveSessionOrigin(request, sessionTarget),
    resolveFallbackTarget: (request) => resolveSessionOrigin(request),
  });
}

function createDiscordApprovalCapability() {
  return createApproverRestrictedNativeApprovalCapability({
    channel: "discord",
    channelLabel: "Discord",
    describeExecApprovalSetup: ({
      accountId,
    }: Parameters<NonNullable<ChannelApprovalCapability["describeExecApprovalSetup"]>>[0]) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.discord.accounts.${accountId}`
          : "channels.discord";
      return `Approve it from the Web UI for now. Discord supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; set \`${prefix}.execApprovals.enabled\` to \`auto\` or \`true\`.`;
    },
    listAccountIds: listDiscordAccountIds,
    hasApprovers: ({ cfg, accountId }) =>
      getDiscordExecApprovalApprovers({ cfg, accountId }).length > 0,
    isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
      isDiscordExecApprovalApprover({ cfg, accountId, senderId }),
    isNativeDeliveryEnabled: ({ cfg, accountId }) =>
      isDiscordExecApprovalClientEnabled({ cfg, accountId }),
    resolveNativeDeliveryMode: ({ cfg, accountId }) =>
      resolveDiscordAccount({ cfg, accountId }).config.execApprovals?.target ?? "dm",
    resolveOriginTarget: createDiscordOriginTargetResolver(),
    resolveApproverDmTargets: createChannelApproverDmTargetResolver({
      shouldHandleRequest: shouldHandleCapabilityRequest,
      resolveApprovers: ({ cfg, accountId }) => getDiscordExecApprovalApprovers({ cfg, accountId }),
      mapApprover: (approver) => ({ to: approver }),
    }),
    notifyOriginWhenDmOnly: true,
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      capabilityBoundary: true,
      eventKinds: ["exec", "plugin", "system-agent"],
      isConfigured: ({ cfg, accountId }) => isDiscordExecApprovalClientEnabled({ cfg, accountId }),
      shouldHandle: shouldHandleCapabilityRequest,
      load: async () =>
        (await import("./approval-handler.runtime.js")).discordApprovalNativeRuntime,
    }),
  });
}

let cachedDiscordApprovalCapability: ReturnType<typeof createDiscordApprovalCapability> | undefined;

export function getDiscordApprovalCapability() {
  cachedDiscordApprovalCapability ??= createDiscordApprovalCapability();
  return cachedDiscordApprovalCapability;
}
