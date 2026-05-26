import { parseBrokerConversationTarget } from "openclaw/plugin-sdk/channel-broker";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-message";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import { parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import {
  listChannelBrokerProviderIds,
  resolveChannelBrokerAccount,
  resolveDefaultChannelBrokerProviderId,
} from "./accounts.js";
import { channelBrokerPluginConfigSchema } from "./config-schema.js";
import {
  sendChannelBrokerMedia,
  sendChannelBrokerOutboundMedia,
  sendChannelBrokerOutboundText,
  sendChannelBrokerText,
} from "./outbound.js";
import { channelBrokerStatus } from "./status.js";
import {
  buildCanonicalChannelBrokerTarget,
  inferChannelBrokerTargetChatType,
  normalizeBrokerTarget,
  parseChannelBrokerTarget,
} from "./target.js";
import type { CoreConfig, ResolvedChannelBrokerAccount } from "./types.js";

const CHANNEL_ID = "channel-broker" as const;

const BROKER_PLATFORM_TARGET_PREFIXES = [
  "broker",
  "channel-broker",
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "imessage",
  "matrix",
  "msteams",
  "teams",
  "googlechat",
  "google-chat",
  "line",
  "wechat",
  "qq",
  "feishu",
  "zalo",
  "irc",
  "mattermost",
  "nextcloud-talk",
  "nostr",
  "tlon",
  "synology-chat",
  "twitch",
] as const;

function resolveBrokerSessionConversation(rawId: string) {
  try {
    const thread = parseThreadSessionSuffix(rawId);
    const rawTarget = thread.baseSessionKey ?? rawId;
    const normalizedTarget = normalizeBrokerTarget(rawTarget) ?? rawTarget;
    const parsed = parseBrokerConversationTarget(normalizedTarget);
    if (parsed.conversationType === "direct") {
      return null;
    }
    const threadId = thread.threadId ?? parsed.threadId;
    const conversationId = `${parsed.platform}:${parsed.conversationId}`;
    return {
      id: conversationId,
      ...(threadId ? { threadId } : {}),
      baseConversationId: conversationId,
      parentConversationCandidates: [conversationId],
    };
  } catch {
    return null;
  }
}

const channelBrokerMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  receive: {
    defaultAckPolicy: "after_durable_send",
    supportedAckPolicies: ["after_receive_record", "after_agent_dispatch", "after_durable_send"],
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
    media: async (ctx) =>
      await sendChannelBrokerMedia({
        cfg: ctx.cfg as CoreConfig,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        mediaUrl: ctx.mediaUrl,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
        silent: ctx.silent,
        audioAsVoice: ctx.audioAsVoice,
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
      targetPrefixes: BROKER_PLATFORM_TARGET_PREFIXES,
      normalizeTarget: normalizeBrokerTarget,
      inferTargetChatType: ({ to }) => inferChannelBrokerTargetChatType(to),
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
      }) => {
        const account = resolveChannelBrokerAccount({ cfg: cfg as CoreConfig, accountId });
        const parsed = parseChannelBrokerTarget({ rawTarget: target, account, threadId });
        const brokerConversationType = parsed.conversationType ?? "channel";
        const chatType = brokerConversationType === "thread" ? "channel" : brokerConversationType;
        const to = buildCanonicalChannelBrokerTarget({
          rawTarget: target,
          account,
          threadId,
        });
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
          precedence: ["threadId"],
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
        },
      },
      resolveTarget: ({ to, cfg, accountId }) => {
        const account = resolveChannelBrokerAccount({ cfg: cfg as CoreConfig, accountId });
        const resolved = to?.trim() || account.defaultTo;
        if (!resolved) {
          return { ok: false, error: new Error("Channel broker target is required.") };
        }
        try {
          return {
            ok: true,
            to: buildCanonicalChannelBrokerTarget({ rawTarget: resolved, account }),
          };
        } catch (cause) {
          return {
            ok: false,
            error: new Error(`Invalid channel broker target: ${resolved}`, { cause }),
          };
        }
      },
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (ctx) => await sendChannelBrokerOutboundText(ctx),
      sendMedia: async (ctx) => await sendChannelBrokerOutboundMedia(ctx),
    },
  },
}) satisfies import("openclaw/plugin-sdk/channel-core").ChannelPlugin<ResolvedChannelBrokerAccount>;
