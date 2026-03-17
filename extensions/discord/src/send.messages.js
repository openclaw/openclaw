import { ChannelType, Routes } from "discord-api-types/v10";
import { resolveDiscordRest } from "./send.shared.js";
async function readMessagesDiscord(channelId, query = {}, opts = {}) {
  const rest = resolveDiscordRest(opts);
  const limit = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.min(Math.max(Math.floor(query.limit), 1), 100) : void 0;
  const params = {};
  if (limit) {
    params.limit = limit;
  }
  if (query.before) {
    params.before = query.before;
  }
  if (query.after) {
    params.after = query.after;
  }
  if (query.around) {
    params.around = query.around;
  }
  return await rest.get(Routes.channelMessages(channelId), params);
}
async function fetchMessageDiscord(channelId, messageId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.channelMessage(channelId, messageId));
}
async function editMessageDiscord(channelId, messageId, payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.patch(Routes.channelMessage(channelId, messageId), {
    body: { content: payload.content }
  });
}
async function deleteMessageDiscord(channelId, messageId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.channelMessage(channelId, messageId));
  return { ok: true };
}
async function pinMessageDiscord(channelId, messageId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  await rest.put(Routes.channelPin(channelId, messageId));
  return { ok: true };
}
async function unpinMessageDiscord(channelId, messageId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.channelPin(channelId, messageId));
  return { ok: true };
}
async function listPinsDiscord(channelId, opts = {}) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.channelPins(channelId));
}
async function createThreadDiscord(channelId, payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  const body = { name: payload.name };
  if (payload.autoArchiveMinutes) {
    body.auto_archive_duration = payload.autoArchiveMinutes;
  }
  if (!payload.messageId && payload.type !== void 0) {
    body.type = payload.type;
  }
  let channelType;
  if (!payload.messageId) {
    try {
      const channel = await rest.get(Routes.channel(channelId));
      channelType = channel?.type;
    } catch {
      channelType = void 0;
    }
  }
  const isForumLike = channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
  if (isForumLike) {
    const starterContent = payload.content?.trim() ? payload.content : payload.name;
    body.message = { content: starterContent };
    if (payload.appliedTags?.length) {
      body.applied_tags = payload.appliedTags;
    }
  }
  if (!payload.messageId && !isForumLike && body.type === void 0) {
    body.type = ChannelType.PublicThread;
  }
  const route = payload.messageId ? Routes.threads(channelId, payload.messageId) : Routes.threads(channelId);
  const thread = await rest.post(route, { body });
  if (!isForumLike && payload.content?.trim()) {
    await rest.post(Routes.channelMessages(thread.id), {
      body: { content: payload.content }
    });
  }
  return thread;
}
async function listThreadsDiscord(payload, opts = {}) {
  const rest = resolveDiscordRest(opts);
  if (payload.includeArchived) {
    if (!payload.channelId) {
      throw new Error("channelId required to list archived threads");
    }
    const params = {};
    if (payload.before) {
      params.before = payload.before;
    }
    if (payload.limit) {
      params.limit = payload.limit;
    }
    return await rest.get(Routes.channelThreads(payload.channelId, "public"), params);
  }
  return await rest.get(Routes.guildActiveThreads(payload.guildId));
}
async function searchMessagesDiscord(query, opts = {}) {
  const rest = resolveDiscordRest(opts);
  const params = new URLSearchParams();
  params.set("content", query.content);
  if (query.channelIds?.length) {
    for (const channelId of query.channelIds) {
      params.append("channel_id", channelId);
    }
  }
  if (query.authorIds?.length) {
    for (const authorId of query.authorIds) {
      params.append("author_id", authorId);
    }
  }
  if (query.limit) {
    const limit = Math.min(Math.max(Math.floor(query.limit), 1), 25);
    params.set("limit", String(limit));
  }
  return await rest.get(`/guilds/${query.guildId}/messages/search?${params.toString()}`);
}
export {
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  fetchMessageDiscord,
  listPinsDiscord,
  listThreadsDiscord,
  pinMessageDiscord,
  readMessagesDiscord,
  searchMessagesDiscord,
  unpinMessageDiscord
};
