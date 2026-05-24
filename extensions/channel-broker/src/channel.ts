import {
  buildBrokerConversationTarget,
  parseBrokerConversationTarget,
  type BrokerConversationTarget,
} from "openclaw/plugin-sdk/channel-broker";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-message";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import {
  listChannelBrokerProviderIds,
  resolveChannelBrokerAccount,
  resolveDefaultChannelBrokerProviderId,
} from "./accounts.js";
import { channelBrokerPluginConfigSchema } from "./config-schema.js";
import { sendChannelBrokerOutboundText, sendChannelBrokerText } from "./outbound.js";
import { CHANNEL_BROKER_PLATFORM_TARGET_PREFIXES } from "./platforms.js";
import { channelBrokerStatus } from "./status.js";
import { normalizeBrokerTarget, parseChannelBrokerTarget } from "./target.js";
import type { CoreConfig, ResolvedChannelBrokerAccount } from "./types.js";

const CHANNEL_ID = "channel-broker" as const;

function inferBrokerTargetChatType(to: string) {
  try {
    const parsed = parseBrokerConversationTarget(to);
    const [maybeType] = parsed.conversationId.split(":", 1);
    if (maybeType === "direct" || maybeType === "group" || maybeType === "channel") {
      return maybeType;
    }
    if (maybeType === "thread") {
      return "channel";
    }
    return "channel";
  } catch {
    return undefined;
  }
}

function resolveBrokerSessionConversation(rawId: string) {
  try {
    const parsed = parseBrokerConversationTarget(rawId);
    if (parsed.conversationType === "direct") {
      return null;
    }
    return {
      id: parsed.conversationId,
      threadId: parsed.threadId,
      baseConversationId: parsed.conversationId,
      parentConversationCandidates: [parsed.conversationId],
    };
  } catch {
    return null;
  }
}

function buildCanonicalBrokerTarget(target: BrokerConversationTarget): string {
  const conversationId =
    target.conversationType && target.conversationType !== "channel"
      ? `${target.conversationType}:${target.conversationId}`
      : target.conversationId;
  return buildBrokerConversationTarget({
    platform: target.platform,
    conversationId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
  });
}

const channelBrokerMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
      reconcileUnknownSend: true,
      afterCommit: true,
    },
  },
  receive: {
    defaultAckPolicy: "after_durable_send",
    supportedAckPolicies: ["after_receive_record", "after_agent_dispatch", "after_durable_send"],
  },
  live: {
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
        previewReceipt: true,
        retainOnAmbiguousFailure: true,
      },
    },
  },
  send: {
    text: async (ctx) =>
      await sendChannelBrokerText({
        cfg: ctx.cfg as CoreConfig,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
        silent: ctx.silent,
        signal: ctx.signal,
      }),
  },
});

export const channelBrokerPlugin = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      ...getChatChannelMeta(CHANNEL_ID),
      preferOver: ["slack", "discord", "telegram"],
    },
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      media: true,
      reply: true,
      threads: true,
      reactions: true,
      edit: true,
    },
    reload: { configPrefixes: ["channels.channel-broker"] },
    configSchema: channelBrokerPluginConfigSchema,
    config: {
      listAccountIds: (cfg) => listChannelBrokerProviderIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolveChannelBrokerAccount({ cfg: cfg as CoreConfig, accountId }),
      defaultAccountId: (cfg) => resolveDefaultChannelBrokerProviderId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      isEnabled: (account) => account.enabled,
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveChannelBrokerAccount({ cfg: cfg as CoreConfig, accountId }).allowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveChannelBrokerAccount({ cfg: cfg as CoreConfig, accountId }).defaultTo,
      describeAccount: (account) => ({
        accountId: account.providerId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.baseUrl ?? undefined,
        allowFrom: account.allowFrom.map(String),
        extra: {
          platforms: account.platforms,
          defaultPlatform: account.defaultPlatform,
        },
      }),
    },
    messaging: {
      targetPrefixes: CHANNEL_BROKER_PLATFORM_TARGET_PREFIXES,
      normalizeTarget: normalizeBrokerTarget,
      inferTargetChatType: ({ to }) => inferBrokerTargetChatType(to),
      targetResolver: {
        looksLikeId: (raw) => Boolean(normalizeBrokerTarget(raw)),
        hint: "<platform>:<conversationId>[?threadId=<threadId>]",
      },
      resolveOutboundSessionRoute: ({
        cfg,
        agentId,
        accountId,
        target,
        replyToId,
        threadId,
        currentSessionKey,
      }) => {
        const account = resolveChannelBrokerAccount({ cfg: cfg as CoreConfig, accountId });
        const parsed = parseChannelBrokerTarget({ rawTarget: target, account, threadId });
        const brokerConversationType = parsed.conversationType ?? "channel";
        const chatType = brokerConversationType === "thread" ? "channel" : brokerConversationType;
        const to = buildCanonicalBrokerTarget(parsed);
        const route = buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId: account.providerId || DEFAULT_ACCOUNT_ID,
          peer: {
            kind: chatType === "direct" ? "direct" : chatType === "group" ? "group" : "channel",
            id: `${parsed.platform}:${parsed.conversationId}`,
          },
          chatType,
          from: `${CHANNEL_ID}:${account.providerId || DEFAULT_ACCOUNT_ID}`,
          to,
        });
        return buildThreadAwareOutboundSessionRoute({
          route,
          replyToId,
          threadId: parsed.threadId ?? threadId,
          currentSessionKey,
          canRecoverCurrentThread: ({ route }) =>
            route.chatType !== "direct" || (cfg.session?.dmScope ?? "main") !== "main",
        });
      },
      resolveSessionConversation: ({ rawId }) => resolveBrokerSessionConversation(rawId),
    },
    status: channelBrokerStatus,
    message: channelBrokerMessageAdapter,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      deliveryCapabilities: {
        durableFinal: {
          text: true,
          replyTo: true,
          thread: true,
          messageSendingHooks: true,
          reconcileUnknownSend: true,
        },
      },
      resolveTarget: ({ to, cfg, accountId }) => {
        const account = resolveChannelBrokerAccount({ cfg: cfg as CoreConfig, accountId });
        const resolved = to?.trim() || account.defaultTo;
        return resolved
          ? { ok: true, to: normalizeBrokerTarget(resolved) ?? resolved }
          : { ok: false, error: new Error("Channel broker target is required.") };
      },
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (ctx) => await sendChannelBrokerOutboundText(ctx),
    },
  },
}) satisfies import("openclaw/plugin-sdk/channel-core").ChannelPlugin<ResolvedChannelBrokerAccount>;
