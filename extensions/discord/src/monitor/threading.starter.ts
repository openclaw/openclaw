import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { isDiscordThreadChannelType } from "../channel-type.js";
import { ChannelType, DiscordError, getChannelMessage, type Client } from "../internal/discord.js";
import {
  resolveDiscordChannelIdSafe,
  resolveDiscordChannelNameSafe,
  resolveDiscordChannelParentIdSafe,
  resolveDiscordChannelParentSafe,
} from "./channel-access.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordMessageChannelId,
} from "./message-channel-info.js";
import type { DiscordChannelInfo, DiscordChannelInfoClient } from "./message-channel-info.js";
import { resolveDiscordRawMessageText } from "./message-text.js";
import { getCachedThreadStarter, setCachedThreadStarter } from "./threading.cache.js";
import type {
  DiscordMessageEvent,
  DiscordReplyDeliveryPlan,
  DiscordThreadChannel,
  DiscordThreadParentInfo,
  DiscordThreadStarter,
  DiscordThreadStarterRestAuthor,
  DiscordThreadStarterRestMessage,
} from "./threading.types.js";

const IN_FLIGHT_DISCORD_THREAD_STARTERS = new Map<string, Promise<DiscordThreadStarter | null>>();

export function resolveDiscordThreadChannel(params: {
  isGuildMessage: boolean;
  message: DiscordMessageEvent["message"];
  channelInfo: DiscordChannelInfo | null;
  messageChannelId?: string;
}): DiscordThreadChannel | null {
  if (!params.isGuildMessage) {
    return null;
  }
  const { message, channelInfo } = params;
  const channel = "channel" in message ? (message as { channel?: unknown }).channel : undefined;
  const isThreadChannel =
    channel &&
    typeof channel === "object" &&
    "isThread" in channel &&
    typeof (channel as { isThread?: unknown }).isThread === "function" &&
    (channel as { isThread: () => boolean }).isThread();
  if (isThreadChannel) {
    return channel as unknown as DiscordThreadChannel;
  }
  if (!isDiscordThreadChannelType(channelInfo?.type)) {
    return null;
  }
  const messageChannelId =
    params.messageChannelId ||
    resolveDiscordMessageChannelId({
      message,
    });
  if (!messageChannelId) {
    return null;
  }
  return {
    id: messageChannelId,
    name: channelInfo?.name ?? undefined,
    parentId: channelInfo?.parentId ?? undefined,
    parent: undefined,
    ownerId: channelInfo?.ownerId ?? undefined,
  };
}

export async function resolveDiscordThreadParentInfo(params: {
  client: DiscordChannelInfoClient;
  threadChannel: DiscordThreadChannel;
  channelInfo: DiscordChannelInfo | null;
}): Promise<DiscordThreadParentInfo> {
  const { threadChannel, channelInfo, client } = params;
  const parent = resolveDiscordChannelParentSafe(threadChannel);
  let parentId =
    resolveDiscordChannelParentIdSafe(threadChannel) ??
    resolveDiscordChannelIdSafe(parent) ??
    channelInfo?.parentId ??
    undefined;
  if (!parentId && threadChannel.id) {
    const threadInfo = await resolveDiscordChannelInfo(client, threadChannel.id);
    parentId = threadInfo?.parentId ?? undefined;
  }
  if (!parentId) {
    return {};
  }
  let parentName = resolveDiscordChannelNameSafe(parent);
  const parentInfo = await resolveDiscordChannelInfo(client, parentId);
  parentName = parentName ?? parentInfo?.name;
  const parentType = parentInfo?.type;
  return { id: parentId, name: parentName, type: parentType };
}

export async function resolveDiscordThreadStarter(params: {
  channel: DiscordThreadChannel;
  client: Client;
  accountId: string;
  parentId?: string;
  parentType?: ChannelType;
  resolveTimestampMs: (value?: string | null) => number | undefined;
}): Promise<DiscordThreadStarter | null> {
  const messageChannelId =
    params.parentType === ChannelType.GuildForum || params.parentType === ChannelType.GuildMedia
      ? params.channel.id
      : params.parentId;
  if (!messageChannelId) {
    return null;
  }
  const cacheKey = `${params.accountId}:${params.channel.id}:${messageChannelId}`;
  const now = Date.now();
  const cached = getCachedThreadStarter(cacheKey, now);
  if (cached) {
    return cached.kind === "hit" ? cached.starter : null;
  }
  const inFlight = IN_FLIGHT_DISCORD_THREAD_STARTERS.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const pending = resolveDiscordThreadStarterUncached(params, cacheKey, messageChannelId);
  IN_FLIGHT_DISCORD_THREAD_STARTERS.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    if (IN_FLIGHT_DISCORD_THREAD_STARTERS.get(cacheKey) === pending) {
      IN_FLIGHT_DISCORD_THREAD_STARTERS.delete(cacheKey);
    }
  }
}

async function resolveDiscordThreadStarterUncached(
  params: Parameters<typeof resolveDiscordThreadStarter>[0],
  cacheKey: string,
  messageChannelId: string,
): Promise<DiscordThreadStarter | null> {
  const cacheMiss = () => {
    setCachedThreadStarter(cacheKey, { kind: "miss" }, Date.now());
  };
  try {
    const starter = (await getChannelMessage(
      params.client.rest,
      messageChannelId,
      params.channel.id,
    )) as DiscordThreadStarterRestMessage | null;
    if (!starter) {
      cacheMiss();
      return null;
    }
    const payload = buildDiscordThreadStarterPayload({
      starter,
      resolveTimestampMs: params.resolveTimestampMs,
    });
    if (!payload) {
      cacheMiss();
      return null;
    }
    setCachedThreadStarter(cacheKey, { kind: "hit", starter: payload }, Date.now());
    return payload;
  } catch (error) {
    if (error instanceof DiscordError && (error.status === 403 || error.status === 404)) {
      cacheMiss();
    }
    return null;
  }
}

function buildDiscordThreadStarterPayload(params: {
  starter: DiscordThreadStarterRestMessage;
  resolveTimestampMs: (value?: string | null) => number | undefined;
}): DiscordThreadStarter | null {
  const text = resolveDiscordRawMessageText(params.starter);
  if (!text) {
    return null;
  }
  const starter = params.starter;
  const authorTag = resolveDiscordThreadStarterAuthorTag(starter.author);
  return {
    text,
    author:
      starter.member?.nick ??
      starter.member?.displayName ??
      authorTag ??
      starter.author?.username ??
      starter.author?.id ??
      "Unknown",
    authorId: starter.author?.id ?? undefined,
    authorName: starter.author?.username ?? undefined,
    authorTag,
    memberRoleIds: Array.isArray(starter.member?.roles) ? starter.member.roles : undefined,
    timestamp: params.resolveTimestampMs(starter.timestamp) ?? undefined,
  };
}

function resolveDiscordThreadStarterAuthorTag(
  author: DiscordThreadStarterRestAuthor | null | undefined,
): string | undefined {
  if (!author?.username || !author.discriminator) {
    return undefined;
  }
  if (author.discriminator !== "0") {
    return `${author.username}#${author.discriminator}`;
  }
  return author.username;
}

export function resolveDiscordReplyTarget(opts: {
  replyToMode: ReplyToMode;
  replyToId?: string;
  hasReplied: boolean;
}): string | undefined {
  if (opts.replyToMode === "off") {
    return undefined;
  }
  const replyToId = normalizeOptionalString(opts.replyToId);
  if (!replyToId) {
    return undefined;
  }
  if (opts.replyToMode === "all") {
    return replyToId;
  }
  return opts.hasReplied ? undefined : replyToId;
}

export function sanitizeDiscordThreadName(rawName: string, fallbackId: string): string {
  const cleanedName = rawName
    .replace(/<@!?\d+>/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const baseSource = cleanedName || `Thread ${fallbackId}`;
  const base = truncateUtf16Safe(baseSource, 80);
  return truncateUtf16Safe(base, 100) || `Thread ${fallbackId}`;
}

export function resolveDiscordReplyDeliveryPlan(params: {
  replyTarget: string;
  replyToMode: ReplyToMode;
  messageId: string;
  threadChannel?: DiscordThreadChannel | null;
  createdThreadId?: string | null;
}): DiscordReplyDeliveryPlan {
  const deliverTarget = params.createdThreadId
    ? `channel:${params.createdThreadId}`
    : params.replyTarget;
  const allowReference = deliverTarget === params.replyTarget;
  const replyReference = createReplyReferencePlanner({
    replyToMode: allowReference ? params.replyToMode : "off",
    existingId: params.threadChannel ? params.messageId : undefined,
    startId: params.messageId,
    allowReference,
  });
  return { deliverTarget, replyTarget: deliverTarget, replyReference };
}
