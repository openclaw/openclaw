import type { APIAttachment, APIMessage, APIUser } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerSessionBindingAdapter } from "openclaw/plugin-sdk/conversation-runtime";
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-runtime";
import { onTestFinished } from "vitest";
import { ChannelType, Message, MessageType } from "../internal/discord.js";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import type { preflightDiscordMessage } from "./message-handler.preflight.js";
import { createNoopThreadBindingManager, type ThreadBindingManager } from "./thread-bindings.js";
type PreflightArgs = Parameters<typeof preflightDiscordMessage>[0];

export type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
export type DiscordMessageEvent = import("./listeners.js").DiscordMessageEvent;
export type DiscordClient = import("../internal/discord.js").Client;

export const DEFAULT_PREFLIGHT_CFG: OpenClawConfig = {
  session: { mainKey: "main", scope: "per-sender" },
};

function user(id: string, username = id): APIUser {
  return { id, username, global_name: null, discriminator: "0", avatar: null };
}

function channelClient(channels: Record<string, object>): DiscordClient {
  return {
    fetchChannel: async (id: string) => (Object.hasOwn(channels, id) ? { ...channels[id] } : null),
  } as unknown as DiscordClient;
}

export function createGuildTextClient(channelId: string): DiscordClient {
  return channelClient({
    [channelId]: { id: channelId, type: ChannelType.GuildText, name: "general" },
  });
}

export function createThreadClient(params: {
  threadId: string;
  parentId: string;
  ownerId?: string;
}): DiscordClient {
  return channelClient({
    [params.parentId]: { id: params.parentId, type: ChannelType.GuildText, name: "general" },
    [params.threadId]: {
      id: params.threadId,
      type: ChannelType.PublicThread,
      name: "focus",
      parentId: params.parentId,
      ownerId: params.ownerId ?? "owner-1",
    },
  });
}

export function createGuildEvent(params: {
  channelId: string;
  guildId: string;
  author: Message["author"];
  message: Message;
  includeGuildObject?: boolean;
}): DiscordMessageEvent {
  return {
    channel_id: params.channelId,
    guild_id: params.guildId,
    ...(params.includeGuildObject === false
      ? {}
      : { guild: { id: params.guildId, name: "Guild One" } }),
    author: params.author,
    message: params.message,
  } as unknown as DiscordMessageEvent;
}

export function createDiscordMessage(
  params: Pick<Message, "id" | "channelId" | "content"> &
    Partial<Pick<Message, "mentionedEveryone" | "messageReference">> &
    Partial<Pick<APIMessage, "type" | "timestamp" | "embeds" | "components">> & {
      author: Pick<APIUser, "id"> & { bot: boolean; username?: string };
      mentionedUsers?: Array<{ id: string; username?: string }>;
      referencedMessage?: Message;
      attachments?: Array<Pick<APIAttachment, "id" | "filename" | "url"> & Partial<APIAttachment>>;
      webhookId?: string;
      stickers?: APIMessage["sticker_items"];
    },
  client: DiscordClient = createInternalTestClient(),
): Message {
  return new Message(client, {
    id: params.id,
    type: params.type ?? MessageType.Default,
    content: params.content,
    timestamp: params.timestamp ?? new Date().toISOString(),
    channel_id: params.channelId,
    webhook_id: params.webhookId,
    attachments: (params.attachments ?? []).map((attachment) =>
      Object.assign({ size: 1, proxy_url: attachment.url }, attachment),
    ),
    mentions: (params.mentionedUsers ?? []).map(({ id, username }) => user(id, username)),
    mention_roles: [],
    mention_everyone: params.mentionedEveryone ?? false,
    message_reference: params.messageReference,
    ...(params.referencedMessage ? { referenced_message: params.referencedMessage.rawData } : {}),
    author: { ...user(params.author.id), ...params.author },
    edited_timestamp: null,
    tts: false,
    pinned: false,
    embeds: params.embeds ?? [],
    components: params.components,
    sticker_items: params.stickers,
  });
}

export function createDiscordPreflightArgs(
  params: Pick<PreflightArgs, "cfg" | "discordConfig" | "data" | "client" | "botUserId"> & {
    threadBindings?: ThreadBindingManager;
  },
): PreflightArgs & { threadBindings: ThreadBindingManager } {
  const threadBindings = params.threadBindings ?? createNoopThreadBindingManager("default");
  if (!params.threadBindings) {
    onTestFinished(() => threadBindings.stop());
  }
  return {
    ...params,
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
  };
}

export function createThreadBinding(overrides?: Partial<SessionBindingRecord>) {
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
    metadata: { agentId: "main", boundBy: "test", webhookId: "wh-1", webhookToken: "tok-1" },
    ...overrides,
  } satisfies SessionBindingRecord;
}

export async function runThreadBoundPreflight(
  params: Parameters<typeof createThreadClient>[0] & {
    message: Message;
    threadBinding: SessionBindingRecord;
    discordConfig: DiscordConfig;
    threadBindings: ThreadBindingManager;
    registerBindingAdapter?: boolean;
  },
) {
  if (params.registerBindingAdapter) {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === params.threadId ? params.threadBinding : null,
    });
  }

  const { preflightDiscordMessage } = await import("./message-handler.preflight.js");
  return preflightDiscordMessage(
    createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      threadBindings: {
        getByThreadId: (id: string) => (id === params.threadId ? params.threadBinding : undefined),
      } as ThreadBindingManager,
      data: createGuildEvent({
        channelId: params.threadId,
        guildId: "guild-1",
        author: params.message.author,
        message: params.message,
      }),
      client: createThreadClient(params),
    }),
  );
}
