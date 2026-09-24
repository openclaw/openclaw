// Discord helper module supports message handler.preflight helpers behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerSessionBindingAdapter } from "openclaw/plugin-sdk/conversation-runtime";
import { onTestFinished } from "vitest";
import { ChannelType } from "../internal/discord.js";
import type { preflightDiscordMessage } from "./message-handler.preflight.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
export type DiscordMessageEvent = import("./listeners.js").DiscordMessageEvent;
export type DiscordClient = import("../internal/discord.js").Client;

export const DEFAULT_PREFLIGHT_CFG = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
} as OpenClawConfig;

export function createGuildTextClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === channelId) {
        return {
          id: channelId,
          type: ChannelType.GuildText,
          name: "general",
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

export function createThreadClient(params: { threadId: string; parentId: string }): DiscordClient {
  return {
    fetchChannel: async (channelId: string) => {
      if (channelId === params.threadId) {
        return {
          id: params.threadId,
          type: ChannelType.PublicThread,
          name: "focus",
          parentId: params.parentId,
          ownerId: "owner-1",
        };
      }
      if (channelId === params.parentId) {
        return {
          id: params.parentId,
          type: ChannelType.GuildText,
          name: "general",
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

export function createGuildEvent(params: {
  channelId: string;
  guildId: string;
  author: import("../internal/discord.js").Message["author"];
  message: import("../internal/discord.js").Message;
  includeGuildObject?: boolean;
}): DiscordMessageEvent {
  return {
    channel_id: params.channelId,
    guild_id: params.guildId,
    ...(params.includeGuildObject === false
      ? {}
      : {
          guild: {
            id: params.guildId,
            name: "Guild One",
          },
        }),
    author: params.author,
    message: params.message,
  } as unknown as DiscordMessageEvent;
}

export function createDiscordMessage(params: {
  id: string;
  channelId: string;
  content: string;
  author: {
    id: string;
    bot: boolean;
    username?: string;
  };
  mentionedUsers?: Array<{ id: string }>;
  mentionedEveryone?: boolean;
  messageReference?: import("../internal/discord.js").Message["messageReference"];
  referencedMessage?: import("../internal/discord.js").Message;
  attachments?: Array<Record<string, unknown>>;
  webhookId?: string;
  type?: import("../internal/discord.js").MessageType;
  timestamp?: string;
}): import("../internal/discord.js").Message {
  return {
    id: params.id,
    type: params.type,
    content: params.content,
    timestamp: params.timestamp ?? new Date().toISOString(),
    channelId: params.channelId,
    webhookId: params.webhookId,
    attachments: params.attachments ?? [],
    mentionedUsers: params.mentionedUsers ?? [],
    mentionedRoles: [],
    mentionedEveryone: params.mentionedEveryone ?? false,
    messageReference: params.messageReference,
    referencedMessage: params.referencedMessage,
    author: params.author,
  } as unknown as import("../internal/discord.js").Message;
}

export function createDiscordPreflightArgs(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  data: DiscordMessageEvent;
  client: DiscordClient;
  botUserId?: string;
  threadBindings?: ReturnType<typeof createNoopThreadBindingManager>;
}): Parameters<typeof preflightDiscordMessage>[0] & {
  threadBindings: ReturnType<typeof createNoopThreadBindingManager>;
} {
  const threadBindings = params.threadBindings ?? createNoopThreadBindingManager("default");
  if (!params.threadBindings) {
    onTestFinished(() => threadBindings.stop());
  }
  return {
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: "default",
    token: "token",
    runtime: {} as import("openclaw/plugin-sdk/runtime-env").RuntimeEnv,
    botUserId: params.botUserId ?? "openclaw-bot",
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1_000_000,
    textLimit: 2_000,
    replyToMode: "all",
    dmEnabled: true,
    groupDmEnabled: true,
    dmPolicy: params.discordConfig?.dmPolicy ?? "pairing",
    ackReactionScope: "direct",
    groupPolicy: "open",
    threadBindings,
    data: params.data,
    client: params.client,
  };
}

export function createThreadBinding(
  overrides?: Partial<import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord>,
) {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:main:subagent:child-1",
    targetKind: "subagent",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: 1,
    metadata: {
      agentId: "main",
      boundBy: "test",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    },
    ...overrides,
  } satisfies import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord;
}

export async function runThreadBoundPreflight(params: {
  threadId: string;
  parentId: string;
  message: import("../internal/discord.js").Message;
  threadBinding: import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord;
  discordConfig: DiscordConfig;
  threadBindings: ReturnType<typeof createNoopThreadBindingManager>;
  registerBindingAdapter?: boolean;
}) {
  if (params.registerBindingAdapter) {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === params.threadId ? params.threadBinding : null,
    });
  }

  const client = createThreadClient({
    threadId: params.threadId,
    parentId: params.parentId,
  });

  const { preflightDiscordMessage } = await import("./message-handler.preflight.js");
  return preflightDiscordMessage({
    ...createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      threadBindings: params.threadBindings,
      data: createGuildEvent({
        channelId: params.threadId,
        guildId: "guild-1",
        author: params.message.author,
        message: params.message,
      }),
      client,
    }),
    threadBindings: {
      getByThreadId: (id: string) => (id === params.threadId ? params.threadBinding : undefined),
    } as import("./thread-bindings.js").ThreadBindingManager,
  });
}
