import { Routes, type APIChannel } from "discord-api-types/v10";
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
  // SAFETY: Discord's Create Guild Channel route returns an API channel.
  return (await rest.post(Routes.guildChannels(payload.guildId), { body })) as APIChannel;
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
  // SAFETY: Discord's Modify Channel route returns the updated API channel.
  return (await rest.patch(Routes.channel(payload.channelId), { body })) as APIChannel;
}

export async function deleteChannelDiscord(channelId: string, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.channel(channelId));
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
  await rest.patch(Routes.guildChannels(payload.guildId), { body });
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
  await rest.put(Routes.channelPermission(payload.channelId, payload.targetId), { body });
  return { ok: true };
}

export async function removeChannelPermissionDiscord(
  channelId: string,
  targetId: string,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.channelPermission(channelId, targetId));
  return { ok: true };
}
