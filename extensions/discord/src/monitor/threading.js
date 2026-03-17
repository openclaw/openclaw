import { ChannelType } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { createReplyReferencePlanner } from "../../../../src/auto-reply/reply/reply-reference.js";
import { logVerbose } from "../../../../src/globals.js";
import { buildAgentSessionKey } from "../../../../src/routing/resolve-route.js";
import { truncateUtf16Safe } from "../../../../src/utils.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordEmbedText,
  resolveDiscordMessageChannelId
} from "./message-utils.js";
const DISCORD_THREAD_STARTER_CACHE_TTL_MS = 5 * 60 * 1e3;
const DISCORD_THREAD_STARTER_CACHE_MAX = 500;
const DISCORD_THREAD_STARTER_CACHE = /* @__PURE__ */ new Map();
function __resetDiscordThreadStarterCacheForTest() {
  DISCORD_THREAD_STARTER_CACHE.clear();
}
function getCachedThreadStarter(key, now) {
  const entry = DISCORD_THREAD_STARTER_CACHE.get(key);
  if (!entry) {
    return void 0;
  }
  if (now - entry.updatedAt > DISCORD_THREAD_STARTER_CACHE_TTL_MS) {
    DISCORD_THREAD_STARTER_CACHE.delete(key);
    return void 0;
  }
  DISCORD_THREAD_STARTER_CACHE.delete(key);
  DISCORD_THREAD_STARTER_CACHE.set(key, { ...entry, updatedAt: now });
  return entry.value;
}
function setCachedThreadStarter(key, value, now) {
  DISCORD_THREAD_STARTER_CACHE.delete(key);
  DISCORD_THREAD_STARTER_CACHE.set(key, { value, updatedAt: now });
  while (DISCORD_THREAD_STARTER_CACHE.size > DISCORD_THREAD_STARTER_CACHE_MAX) {
    const iter = DISCORD_THREAD_STARTER_CACHE.keys().next();
    if (iter.done) {
      break;
    }
    DISCORD_THREAD_STARTER_CACHE.delete(iter.value);
  }
}
function isDiscordThreadType(type) {
  return type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread;
}
function resolveTrimmedDiscordMessageChannelId(params) {
  return (params.messageChannelId || resolveDiscordMessageChannelId({
    message: params.message
  })).trim();
}
function resolveDiscordThreadChannel(params) {
  if (!params.isGuildMessage) {
    return null;
  }
  const { message, channelInfo } = params;
  const channel = "channel" in message ? message.channel : void 0;
  const isThreadChannel = channel && typeof channel === "object" && "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
  if (isThreadChannel) {
    return channel;
  }
  if (!isDiscordThreadType(channelInfo?.type)) {
    return null;
  }
  const messageChannelId = params.messageChannelId || resolveDiscordMessageChannelId({
    message
  });
  if (!messageChannelId) {
    return null;
  }
  return {
    id: messageChannelId,
    name: channelInfo?.name ?? void 0,
    parentId: channelInfo?.parentId ?? void 0,
    parent: void 0,
    ownerId: channelInfo?.ownerId ?? void 0
  };
}
async function resolveDiscordThreadParentInfo(params) {
  const { threadChannel, channelInfo, client } = params;
  let parentId = threadChannel.parentId ?? threadChannel.parent?.id ?? channelInfo?.parentId ?? void 0;
  if (!parentId && threadChannel.id) {
    const threadInfo = await resolveDiscordChannelInfo(client, threadChannel.id);
    parentId = threadInfo?.parentId ?? void 0;
  }
  if (!parentId) {
    return {};
  }
  let parentName = threadChannel.parent?.name;
  const parentInfo = await resolveDiscordChannelInfo(client, parentId);
  parentName = parentName ?? parentInfo?.name;
  const parentType = parentInfo?.type;
  return { id: parentId, name: parentName, type: parentType };
}
async function resolveDiscordThreadStarter(params) {
  const cacheKey = params.channel.id;
  const now = Date.now();
  const cached = getCachedThreadStarter(cacheKey, now);
  if (cached) {
    return cached;
  }
  try {
    const parentType = params.parentType;
    const isForumParent = parentType === ChannelType.GuildForum || parentType === ChannelType.GuildMedia;
    const messageChannelId = isForumParent ? params.channel.id : params.parentId;
    if (!messageChannelId) {
      return null;
    }
    const starter = await params.client.rest.get(
      Routes.channelMessage(messageChannelId, params.channel.id)
    );
    if (!starter) {
      return null;
    }
    const content = starter.content?.trim() ?? "";
    const embedText = resolveDiscordEmbedText(starter.embeds?.[0]);
    const text = content || embedText;
    if (!text) {
      return null;
    }
    const author = starter.member?.nick ?? starter.member?.displayName ?? (starter.author ? starter.author.discriminator && starter.author.discriminator !== "0" ? `${starter.author.username ?? "Unknown"}#${starter.author.discriminator}` : starter.author.username ?? starter.author.id ?? "Unknown" : "Unknown");
    const timestamp = params.resolveTimestampMs(starter.timestamp);
    const payload = {
      text,
      author,
      timestamp: timestamp ?? void 0
    };
    setCachedThreadStarter(cacheKey, payload, Date.now());
    return payload;
  } catch {
    return null;
  }
}
function resolveDiscordReplyTarget(opts) {
  if (opts.replyToMode === "off") {
    return void 0;
  }
  const replyToId = opts.replyToId?.trim();
  if (!replyToId) {
    return void 0;
  }
  if (opts.replyToMode === "all") {
    return replyToId;
  }
  return opts.hasReplied ? void 0 : replyToId;
}
function sanitizeDiscordThreadName(rawName, fallbackId) {
  const cleanedName = rawName.replace(/<@!?\d+>/g, "").replace(/<@&\d+>/g, "").replace(/<#\d+>/g, "").replace(/\s+/g, " ").trim();
  const baseSource = cleanedName || `Thread ${fallbackId}`;
  const base = truncateUtf16Safe(baseSource, 80);
  return truncateUtf16Safe(base, 100) || `Thread ${fallbackId}`;
}
function resolveDiscordAutoThreadContext(params) {
  const createdThreadId = String(params.createdThreadId ?? "").trim();
  if (!createdThreadId) {
    return null;
  }
  const messageChannelId = params.messageChannelId.trim();
  if (!messageChannelId) {
    return null;
  }
  const threadSessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    peer: { kind: "channel", id: createdThreadId }
  });
  const parentSessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    peer: { kind: "channel", id: messageChannelId }
  });
  return {
    createdThreadId,
    From: `${params.channel}:channel:${createdThreadId}`,
    To: `channel:${createdThreadId}`,
    OriginatingTo: `channel:${createdThreadId}`,
    SessionKey: threadSessionKey,
    ParentSessionKey: parentSessionKey
  };
}
async function resolveDiscordAutoThreadReplyPlan(params) {
  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  const targetChannelId = params.threadChannel?.id ?? (messageChannelId || "unknown");
  const originalReplyTarget = `channel:${targetChannelId}`;
  const createdThreadId = await maybeCreateDiscordAutoThread({
    client: params.client,
    message: params.message,
    messageChannelId: messageChannelId || void 0,
    isGuildMessage: params.isGuildMessage,
    channelConfig: params.channelConfig,
    threadChannel: params.threadChannel,
    channelType: params.channelType,
    baseText: params.baseText,
    combinedBody: params.combinedBody
  });
  const deliveryPlan = resolveDiscordReplyDeliveryPlan({
    replyTarget: originalReplyTarget,
    replyToMode: params.replyToMode,
    messageId: params.message.id,
    threadChannel: params.threadChannel,
    createdThreadId
  });
  const autoThreadContext = params.isGuildMessage ? resolveDiscordAutoThreadContext({
    agentId: params.agentId,
    channel: params.channel,
    messageChannelId,
    createdThreadId
  }) : null;
  return { ...deliveryPlan, createdThreadId, autoThreadContext };
}
async function maybeCreateDiscordAutoThread(params) {
  if (!params.isGuildMessage) {
    return void 0;
  }
  if (!params.channelConfig?.autoThread) {
    return void 0;
  }
  if (params.threadChannel) {
    return void 0;
  }
  if (params.channelType === ChannelType.GuildForum || params.channelType === ChannelType.GuildMedia || params.channelType === ChannelType.GuildVoice || params.channelType === ChannelType.GuildStageVoice) {
    return void 0;
  }
  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  if (!messageChannelId) {
    return void 0;
  }
  try {
    const threadName = sanitizeDiscordThreadName(
      params.baseText || params.combinedBody || "Thread",
      params.message.id
    );
    const archiveDuration = params.channelConfig?.autoArchiveDuration ? Number(params.channelConfig.autoArchiveDuration) : 60;
    const created = await params.client.rest.post(
      `${Routes.channelMessage(messageChannelId, params.message.id)}/threads`,
      {
        body: {
          name: threadName,
          auto_archive_duration: archiveDuration
        }
      }
    );
    const createdId = created?.id ? String(created.id) : "";
    return createdId || void 0;
  } catch (err) {
    logVerbose(
      `discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`
    );
    try {
      const msg = await params.client.rest.get(
        Routes.channelMessage(messageChannelId, params.message.id)
      );
      const existingThreadId = msg?.thread?.id ? String(msg.thread.id) : "";
      if (existingThreadId) {
        logVerbose(
          `discord: autoThread reusing existing thread ${existingThreadId} on ${messageChannelId}/${params.message.id}`
        );
        return existingThreadId;
      }
    } catch {
    }
    return void 0;
  }
}
function resolveDiscordReplyDeliveryPlan(params) {
  const originalReplyTarget = params.replyTarget;
  let deliverTarget = originalReplyTarget;
  let replyTarget = originalReplyTarget;
  if (params.createdThreadId) {
    deliverTarget = `channel:${params.createdThreadId}`;
    replyTarget = deliverTarget;
  }
  const allowReference = deliverTarget === originalReplyTarget;
  const replyReference = createReplyReferencePlanner({
    replyToMode: allowReference ? params.replyToMode : "off",
    existingId: params.threadChannel ? params.messageId : void 0,
    startId: params.messageId,
    allowReference
  });
  return { deliverTarget, replyTarget, replyReference };
}
export {
  __resetDiscordThreadStarterCacheForTest,
  maybeCreateDiscordAutoThread,
  resolveDiscordAutoThreadContext,
  resolveDiscordAutoThreadReplyPlan,
  resolveDiscordReplyDeliveryPlan,
  resolveDiscordReplyTarget,
  resolveDiscordThreadChannel,
  resolveDiscordThreadParentInfo,
  resolveDiscordThreadStarter,
  sanitizeDiscordThreadName
};
