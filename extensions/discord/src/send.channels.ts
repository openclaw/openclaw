import type { APIChannel } from "discord-api-types/v10";
import {
  createGuildChannel,
  deleteChannel,
  deleteChannelPermission,
  editChannel,
  moveGuildChannels,
  putChannelPermission,
} from "./internal/discord.js";
import { stripUndefinedFields } from "./internal/undefined-fields.js";
import { resolveDiscordRest } from "./send.shared.js";
import type {
  DiscordChannelCreate,
  DiscordChannelEdit,
  DiscordChannelMove,
  DiscordChannelPermissionSet,
  DiscordReactOpts,
} from "./send.types.js";

export async function createChannelDiscord(
  payload: DiscordChannelCreate,
  opts: DiscordReactOpts,
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  const body = stripUndefinedFields({
    name: payload.name,
    type: payload.type,
    parent_id: payload.parentId || undefined,
    topic: payload.topic || undefined,
    position: payload.position,
    nsfw: payload.nsfw,
  });
  return await createGuildChannel(rest, payload.guildId, {
    body,
  });
}

export async function editChannelDiscord(
  payload: DiscordChannelEdit,
  opts: DiscordReactOpts,
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  const body = stripUndefinedFields({
    name: payload.name,
    topic: payload.topic,
    position: payload.position,
    parent_id: payload.parentId,
    nsfw: payload.nsfw,
    rate_limit_per_user: payload.rateLimitPerUser,
    archived: payload.archived,
    locked: payload.locked,
    auto_archive_duration: payload.autoArchiveDuration,
    available_tags:
      payload.availableTags === undefined
        ? undefined
        : payload.availableTags.map((tag) =>
            stripUndefinedFields({
              id: tag.id,
              name: tag.name,
              moderated: tag.moderated,
              emoji_id: tag.emoji_id,
              emoji_name: tag.emoji_name,
            }),
          ),
  });
  return await editChannel(rest, payload.channelId, {
    body,
  });
}

export async function deleteChannelDiscord(channelId: string, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await deleteChannel(rest, channelId);
  return { ok: true, channelId };
}

export async function moveChannelDiscord(payload: DiscordChannelMove, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  const body: Array<Record<string, unknown>> = [
    {
      id: payload.channelId,
      ...(payload.parentId !== undefined && { parent_id: payload.parentId }),
      ...(payload.position !== undefined && { position: payload.position }),
    },
  ];
  await moveGuildChannels(rest, payload.guildId, { body });
  return { ok: true };
}

export async function setChannelPermissionDiscord(
  payload: DiscordChannelPermissionSet,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  const body = stripUndefinedFields({
    type: payload.targetType,
    allow: payload.allow,
    deny: payload.deny,
  });
  await putChannelPermission(rest, payload.channelId, payload.targetId, { body });
  return { ok: true };
}

export async function removeChannelPermissionDiscord(
  channelId: string,
  targetId: string,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  await deleteChannelPermission(rest, channelId, targetId);
  return { ok: true };
}
