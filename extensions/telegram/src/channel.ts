import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  buildDmGroupAccountAllowlistAdapter,
  createNestedAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  buildOutboundBaseSessionKey,
  normalizeMessageChannel,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import {
  listTelegramAccountIds,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";
import { resolveTelegramAutoThreadId } from "./action-threading.js";
import { lookupTelegramChatId } from "./api-fetch.js";
import { telegramApprovalCapability } from "./approval-native.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";
import { telegramMessageActions as telegramMessageActionsImpl } from "./channel-actions.js";
import {
  matchTelegramAcpConversation,
  normalizeTelegramAcpConversationId,
  resolveTelegramCommandConversation,
} from "./channel-bindings.js";
import {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "./directory-config.js";
import { buildTelegramExecApprovalPendingPayload } from "./exec-approval-forwarding.js";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
  shouldSuppressLocalTelegramExecApprovalPrompt,
} from "./exec-approvals.js";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-policy.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./normalize.js";
import { telegramChannelOutbound } from "./outbound-base.js";
import { parseTelegramThreadId } from "./outbound-params.js";
import { telegramPairingText } from "./pairing-text.js";
import type { TelegramProbe } from "./probe.js";
import { resolveTelegramReactionLevel } from "./reaction-level.js";
import { getTelegramRuntime } from "./runtime.js";
import { resolveTelegramSessionConversation } from "./session-conversation.js";
import { telegramSetupAdapter } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";
import { createTelegramPluginBase, telegramConfigAdapter } from "./shared.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import { parseTelegramTarget } from "./targets.js";
import { telegramGateway } from "./telegram-gateway.js";
import { telegramStatus } from "./telegram-status.js";
import { telegramThreading } from "./telegram-threading.js";
import {
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

let telegramAuditModulePromise: Promise<typeof import("./audit.js")> | null = null;
let telegramMonitorModulePromise: Promise<typeof import("./monitor.js")> | null = null;
let telegramProbeModulePromise: Promise<typeof import("./probe.js")> | null = null;
async function loadTelegramAuditModule() {
  telegramAuditModulePromise ??= import("./audit.js");
  return await telegramAuditModulePromise;
}

async function loadTelegramProbeModule() {
  telegramProbeModulePromise ??= import("./probe.js");
  return await telegramProbeModulePromise;
}

async function resolveTelegramProbe() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.probeTelegram ??
    (await loadTelegramProbeModule()).probeTelegram
  );
}

async function resolveTelegramAuditCollector() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.collectTelegramUnmentionedGroupIds ??
    (await loadTelegramAuditModule()).collectTelegramUnmentionedGroupIds
  );
}

function getOptionalTelegramRuntime() {
  try {
    return getTelegramRuntime();
  } catch {
    return null;
  }
}

const telegramMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: (ctx) =>
    getOptionalTelegramRuntime()?.channel?.telegram?.messageActions?.describeMessageTool?.(ctx) ??
    telegramMessageActionsImpl.describeMessageTool?.(ctx) ??
    null,
  extractToolSend: (ctx) =>
    getOptionalTelegramRuntime()?.channel?.telegram?.messageActions?.extractToolSend?.(ctx) ??
    telegramMessageActionsImpl.extractToolSend?.(ctx) ??
    null,
  handleAction: async (ctx) => {
    const runtimeHandleAction =
      getOptionalTelegramRuntime()?.channel?.telegram?.messageActions?.handleAction;
    if (runtimeHandleAction) {
      return await runtimeHandleAction(ctx);
    }
    if (!telegramMessageActionsImpl.handleAction) {
      throw new Error("Telegram message actions not available");
    }
    return await telegramMessageActionsImpl.handleAction(ctx);
  },
};

function parseTelegramExplicitTarget(raw: string) {
  const target = parseTelegramTarget(raw);
  return {
    to: target.chatId,
    threadId: target.messageThreadId,
    chatType: target.chatType === "unknown" ? undefined : target.chatType,
  };
}

function buildTelegramBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "telegram" });
}

function resolveTelegramOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { kind: string };
  threadId?: string | number | null;
}) {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const fallbackThreadId = normalizeOutboundThreadId(params.threadId);
  const resolvedThreadId = parsed.messageThreadId ?? parseTelegramThreadId(fallbackThreadId);
  const isGroup =
    parsed.chatType === "group" ||
    (parsed.chatType === "unknown" &&
      params.resolvedTarget?.kind &&
      params.resolvedTarget.kind !== "user");
  const peerId =
    isGroup && resolvedThreadId ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : chatId;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "direct",
    id: peerId,
  };
  const baseSessionKey = buildTelegramBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer,
  });
  const threadKeys =
    resolvedThreadId && !isGroup
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(resolvedThreadId) })
      : null;
  return {
    sessionKey: threadKeys?.sessionKey ?? baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? ("group" as const) : ("direct" as const),
    from: isGroup
      ? `telegram:group:${peerId}`
      : resolvedThreadId
        ? `telegram:${chatId}:topic:${resolvedThreadId}`
        : `telegram:${chatId}`,
    to: `telegram:${chatId}`,
    threadId: resolvedThreadId,
  };
}

async function resolveTelegramTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  inputs: string[];
  kind: "user" | "group";
}) {
  if (params.kind !== "user") {
    return params.inputs.map((input) => ({
      input,
      resolved: false as const,
      note: "Telegram runtime target resolution only supports usernames for direct-message lookups.",
    }));
  }
  const account = resolveTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const token = account.token.trim();
  if (!token) {
    return params.inputs.map((input) => ({
      input,
      resolved: false as const,
      note: "Telegram bot token is required to resolve @username targets.",
    }));
  }
  return await Promise.all(
    params.inputs.map(async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return {
          input,
          resolved: false as const,
          note: "Telegram target is required.",
        };
      }
      const normalized = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      try {
        const id = await lookupTelegramChatId({
          token,
          chatId: normalized,
          network: account.config.network,
        });
        if (!id) {
          return {
            input,
            resolved: false as const,
            note: "Telegram username could not be resolved by the configured bot.",
          };
        }
        return {
          input,
          resolved: true as const,
          id,
          name: normalized,
        };
      } catch (error) {
        return {
          input,
          resolved: false as const,
          note: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

const resolveTelegramAllowlistGroupOverrides = createNestedAllowlistOverrideResolver({
  resolveRecord: (account: ResolvedTelegramAccount) => account.config.groups,
  outerLabel: (groupId) => groupId,
  resolveOuterEntries: (groupCfg) => groupCfg?.allowFrom,
  resolveChildren: (groupCfg) => groupCfg?.topics,
  innerLabel: (groupId, topicId) => `${groupId} topic ${topicId}`,
  resolveInnerEntries: (topicCfg) => topicCfg?.allowFrom,
});

const collectTelegramSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedTelegramAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.telegram !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.groups) && Object.keys(account.config.groups ?? {}).length > 0,
    restrictSenders: {
      surface: "Telegram groups",
      openScope: "any member in allowed groups",
      groupPolicyPath: "channels.telegram.groupPolicy",
      groupAllowFromPath: "channels.telegram.groupAllowFrom",
    },
    noRouteAllowlist: {
      surface: "Telegram groups",
      routeAllowlistPath: "channels.telegram.groups",
      routeScope: "group",
      groupPolicyPath: "channels.telegram.groupPolicy",
      groupAllowFromPath: "channels.telegram.groupAllowFrom",
    },
  });

export const telegramPlugin = createChatChannelPlugin({
  base: {
    ...createTelegramPluginBase({
      setupWizard: telegramSetupWizard,
      setup: telegramSetupAdapter,
    }),
    allowlist: buildDmGroupAccountAllowlistAdapter({
      channelId: "telegram",
      resolveAccount: resolveTelegramAccount,
      normalize: ({ cfg, accountId, values }) =>
        telegramConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolveDmAllowFrom: (account) => account.config.allowFrom,
      resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
      resolveDmPolicy: (account) => account.config.dmPolicy,
      resolveGroupPolicy: (account) => account.config.groupPolicy,
      resolveGroupOverrides: resolveTelegramAllowlistGroupOverrides,
    }),
    bindings: {
      compileConfiguredBinding: ({ conversationId }) =>
        normalizeTelegramAcpConversationId(conversationId),
      matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
        matchTelegramAcpConversation({
          bindingConversationId: compiledBinding.conversationId,
          conversationId,
          parentConversationId,
        }),
      resolveCommandConversation: ({ threadId, originatingTo, commandTo, fallbackTo }) =>
        resolveTelegramCommandConversation({
          threadId,
          originatingTo,
          commandTo,
          fallbackTo,
        }),
    },
    conversationBindings: {
      supportsCurrentConversationBinding: true,
      createManager: ({ accountId }) =>
        createTelegramThreadBindingManager({
          accountId: accountId ?? undefined,
          persist: false,
          enableSweeper: false,
        }),
      setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
        setTelegramThreadBindingIdleTimeoutBySessionKey({
          targetSessionKey,
          accountId: accountId ?? undefined,
          idleTimeoutMs,
        }),
      setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
        setTelegramThreadBindingMaxAgeBySessionKey({
          targetSessionKey,
          accountId: accountId ?? undefined,
          maxAgeMs,
        }),
    },
    groups: {
      resolveRequireMention: resolveTelegramGroupRequireMention,
      resolveToolPolicy: resolveTelegramGroupToolPolicy,
    },
    agentPrompt: {
      messageToolCapabilities: ({ cfg, accountId }) => {
        const inlineButtonsScope = resolveTelegramInlineButtonsScope({
          cfg,
          accountId: accountId ?? undefined,
        });
        return inlineButtonsScope === "off" ? [] : ["inlineButtons"];
      },
      reactionGuidance: ({ cfg, accountId }) => {
        const level = resolveTelegramReactionLevel({
          cfg,
          accountId: accountId ?? undefined,
        }).agentReactionGuidance;
        return level ? { level, channelLabel: "Telegram" } : undefined;
      },
    },
    messaging: {
      normalizeTarget: normalizeTelegramMessagingTarget,
      resolveSessionConversation: ({ kind, rawId }) =>
        resolveTelegramSessionConversation({ kind, rawId }),
      parseExplicitTarget: ({ raw }) => parseTelegramExplicitTarget(raw),
      inferTargetChatType: ({ to }) => parseTelegramExplicitTarget(to).chatType,
      formatTargetDisplay: ({ target, display, kind }) => {
        const formatted = display?.trim();
        if (formatted) {
          return formatted;
        }
        const trimmedTarget = target.trim();
        if (!trimmedTarget) {
          return trimmedTarget;
        }
        const withoutProvider = trimmedTarget.replace(/^(telegram|tg):/i, "");
        if (kind === "user" || /^user:/i.test(withoutProvider)) {
          return `@${withoutProvider.replace(/^user:/i, "")}`;
        }
        if (/^channel:/i.test(withoutProvider)) {
          return `#${withoutProvider.replace(/^channel:/i, "")}`;
        }
        return withoutProvider;
      },
      resolveOutboundSessionRoute: (params) => resolveTelegramOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: looksLikeTelegramTargetId,
        hint: "<chatId>",
      },
    },
    resolver: {
      resolveTargets: async ({ cfg, accountId, inputs, kind }) =>
        await resolveTelegramTargets({ cfg, accountId, inputs, kind }),
    },
    lifecycle: {
      onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
        const previousToken = resolveTelegramAccount({ cfg: prevCfg, accountId }).token.trim();
        const nextToken = resolveTelegramAccount({ cfg: nextCfg, accountId }).token.trim();
        if (previousToken !== nextToken) {
          const { deleteTelegramUpdateOffset } = await import("../update-offset-runtime-api.js");
          await deleteTelegramUpdateOffset({ accountId });
        }
      },
      onAccountRemoved: async ({ accountId }) => {
        const { deleteTelegramUpdateOffset } = await import("../update-offset-runtime-api.js");
        await deleteTelegramUpdateOffset({ accountId });
      },
    },
    approvalCapability: {
      ...telegramApprovalCapability,
      render: {
        exec: {
          buildPendingPayload: ({ request, nowMs }) =>
            buildTelegramExecApprovalPendingPayload({ request, nowMs }),
        },
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
      listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
    }),
    actions: telegramMessageActions,
    status: telegramStatus,
    gateway: telegramGateway,
  },
  pairing: {
    text: telegramPairingText,
  },
  security: {
    dm: {
      channelKey: "telegram",
      resolvePolicy: (account) => account.config.dmPolicy,
      resolveAllowFrom: (account) => account.config.allowFrom,
      policyPathSuffix: "dmPolicy",
      normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
    },
    collectWarnings: collectTelegramSecurityWarnings,
  },
  threading: telegramThreading,
  outbound: telegramChannelOutbound,
});
