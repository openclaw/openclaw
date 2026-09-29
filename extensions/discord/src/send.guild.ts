import type {
  APIGuild,
  APIGuildMember,
  APIGuildScheduledEvent,
  APIRole,
  APIVoiceState,
  RESTPostAPIGuildScheduledEventJSONBody,
} from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import { buildOutboundMediaLoadOptions } from "openclaw/plugin-sdk/media-runtime";
import {
  resolveExpiresAtMsFromDurationMs,
  timestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import {
  getChannel,
  getGuild,
  getGuildMember,
  getGuildVoiceState,
  isUnknownDiscordVoiceStateError,
  type APIChannel,
} from "./internal/discord.js";
import { resolveDiscordRest } from "./send.shared.js";
import type {
  DiscordModerationTarget,
  DiscordOutboundMediaOpts,
  DiscordReactOpts,
  DiscordRoleChange,
  DiscordTimeoutTarget,
} from "./send.types.js";
import { DISCORD_MAX_EVENT_COVER_BYTES } from "./send.types.js";

type DiscordAbsentVoiceState = Pick<APIVoiceState, "guild_id" | "user_id" | "channel_id"> & {
  connected: false;
  absent: true;
  reason: "unknown_voice_state";
};

type DiscordVoiceStatus = APIVoiceState | DiscordAbsentVoiceState;

export async function fetchMemberInfoDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts,
): Promise<APIGuildMember> {
  const rest = resolveDiscordRest(opts);
  return await getGuildMember(rest, guildId, userId);
}

export async function fetchRoleInfoDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<APIRole[]> {
  const rest = resolveDiscordRest(opts);
  // SAFETY: Discord's Get Guild Roles route returns an array of API roles.
  return (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
}

export async function addRoleDiscord(payload: DiscordRoleChange, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await rest.put(Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId));
  return { ok: true };
}

export async function removeRoleDiscord(payload: DiscordRoleChange, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId));
  return { ok: true };
}

export async function fetchChannelInfoDiscord(
  channelId: string,
  opts: DiscordReactOpts,
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  return await getChannel(rest, channelId);
}

export async function fetchGuildInfoDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<APIGuild> {
  const rest = resolveDiscordRest(opts);
  return await getGuild(rest, guildId);
}

export async function listGuildChannelsDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<APIChannel[]> {
  const rest = resolveDiscordRest(opts);
  // SAFETY: Discord's Get Guild Channels route returns an array of API channels.
  return (await rest.get(Routes.guildChannels(guildId))) as APIChannel[];
}

export async function fetchVoiceStatusDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts,
): Promise<DiscordVoiceStatus> {
  const rest = resolveDiscordRest(opts);
  try {
    return await getGuildVoiceState(rest, guildId, userId);
  } catch (err) {
    if (!isUnknownDiscordVoiceStateError(err)) {
      throw err;
    }
    return {
      guild_id: guildId,
      user_id: userId,
      channel_id: null,
      connected: false,
      absent: true,
      reason: "unknown_voice_state",
    };
  }
}

export async function listScheduledEventsDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<APIGuildScheduledEvent[]> {
  const rest = resolveDiscordRest(opts);
  // SAFETY: Discord's List Scheduled Events route returns API scheduled events.
  return (await rest.get(Routes.guildScheduledEvents(guildId))) as APIGuildScheduledEvent[];
}

const ALLOWED_EVENT_COVER_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif"]);

// Loads an image from a URL or path and returns a data URI suitable for the Discord API.
export async function resolveEventCoverImage(
  imageUrl: string,
  opts?: DiscordOutboundMediaOpts,
): Promise<string> {
  // Security: cover images are host-local reads, so the sender-scoped policy bounds them too.
  const media = await loadWebMediaRaw(
    imageUrl,
    buildOutboundMediaLoadOptions({
      maxBytes: DISCORD_MAX_EVENT_COVER_BYTES,
      mediaAccess: opts?.mediaAccess,
      mediaLocalRoots: opts?.mediaLocalRoots,
      mediaReadFile: opts?.mediaReadFile,
    }),
  );
  const contentType = normalizeOptionalLowercaseString(media.contentType);
  if (!contentType || !ALLOWED_EVENT_COVER_TYPES.has(contentType)) {
    throw new Error(
      `Discord event cover images must be PNG, JPG, or GIF (got ${contentType ?? "unknown"})`,
    );
  }
  return `data:${contentType};base64,${media.buffer.toString("base64")}`;
}

export async function createScheduledEventDiscord(
  guildId: string,
  payload: RESTPostAPIGuildScheduledEventJSONBody,
  opts: DiscordReactOpts,
): Promise<APIGuildScheduledEvent> {
  const rest = resolveDiscordRest(opts);
  const event = await rest.post(Routes.guildScheduledEvents(guildId), {
    body: payload,
  });
  // SAFETY: Discord's Create Scheduled Event route returns the created API event.
  return event as APIGuildScheduledEvent;
}

export async function timeoutMemberDiscord(
  payload: DiscordTimeoutTarget,
  opts: DiscordReactOpts,
): Promise<APIGuildMember> {
  const rest = resolveDiscordRest(opts);
  let until = payload.until;
  if (!until && payload.durationMinutes) {
    const ms = payload.durationMinutes * 60 * 1000;
    until = timestampMsToIsoString(resolveExpiresAtMsFromDurationMs(ms));
    if (!until) {
      throw new Error("Discord timeout duration is outside the supported Date range");
    }
  }
  const member = await rest.patch(Routes.guildMember(payload.guildId, payload.userId), {
    body: { communication_disabled_until: until ?? null },
    headers: payload.reason
      ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
      : undefined,
  });
  // SAFETY: Discord's Modify Guild Member route returns the updated API member.
  return member as APIGuildMember;
}

export async function kickMemberDiscord(payload: DiscordModerationTarget, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.guildMember(payload.guildId, payload.userId), {
    headers: payload.reason
      ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
      : undefined,
  });
  return { ok: true };
}

export async function banMemberDiscord(
  payload: DiscordModerationTarget & { deleteMessageDays?: number },
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  const deleteMessageDays =
    typeof payload.deleteMessageDays === "number" && Number.isFinite(payload.deleteMessageDays)
      ? Math.min(Math.max(Math.floor(payload.deleteMessageDays), 0), 7)
      : undefined;
  await rest.put(Routes.guildBan(payload.guildId, payload.userId), {
    body: deleteMessageDays !== undefined ? { delete_message_days: deleteMessageDays } : undefined,
    headers: payload.reason
      ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
      : undefined,
  });
  return { ok: true };
}
