import type {
  APIGuildMember,
  APIGuildScheduledEvent,
  APIRole,
  APIVoiceState,
  RESTPostAPIGuildScheduledEventJSONBody,
} from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import {
  resolveExpiresAtMsFromDurationMs,
  timestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import {
  getChannel,
  getGuild,
  getGuildMember,
  getGuildVoiceState,
  isUnknownDiscordVoiceStateError,
  type APIChannel,
  type RequestClient,
} from "./internal/discord.js";
import { DISCORD_IMAGE_UPLOAD_TYPES, loadDiscordMediaForUpload } from "./send.emojis-stickers.js";
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

function readDiscordResource<T>(read: (rest: RequestClient, id: string) => Promise<T>) {
  return async (id: string, opts: DiscordReactOpts): Promise<T> =>
    await read(resolveDiscordRest(opts), id);
}

function auditReasonHeaders(reason?: string) {
  return reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason) } : undefined;
}

export async function fetchMemberInfoDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts,
): Promise<APIGuildMember> {
  const rest = resolveDiscordRest(opts);
  return await getGuildMember(rest, guildId, userId);
}

export const fetchRoleInfoDiscord = readDiscordResource(async (rest, guildId) => {
  // SAFETY: Discord's Get Guild Roles route returns an array of API roles.
  return (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
});

function roleMutation(method: "put" | "delete") {
  return async (payload: DiscordRoleChange, opts: DiscordReactOpts) => {
    const rest = resolveDiscordRest(opts);
    await rest[method](Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId));
    return { ok: true };
  };
}

export const addRoleDiscord = roleMutation("put");
export const removeRoleDiscord = roleMutation("delete");

export const fetchChannelInfoDiscord = readDiscordResource(getChannel);

export const fetchGuildInfoDiscord = readDiscordResource(getGuild);

export const listGuildChannelsDiscord = readDiscordResource(async (rest, guildId) => {
  // SAFETY: Discord's Get Guild Channels route returns an array of API channels.
  return (await rest.get(Routes.guildChannels(guildId))) as APIChannel[];
});

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

export const listScheduledEventsDiscord = readDiscordResource(async (rest, guildId) => {
  // SAFETY: Discord's List Scheduled Events route returns API scheduled events.
  return (await rest.get(Routes.guildScheduledEvents(guildId))) as APIGuildScheduledEvent[];
});

export async function resolveEventCoverImage(
  imageUrl: string,
  opts?: DiscordOutboundMediaOpts,
): Promise<string> {
  const { media, contentType } = await loadDiscordMediaForUpload(
    imageUrl,
    opts,
    DISCORD_MAX_EVENT_COVER_BYTES,
    DISCORD_IMAGE_UPLOAD_TYPES,
    (actualType) =>
      `Discord event cover images must be PNG, JPG, or GIF (got ${actualType ?? "unknown"})`,
  );
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
    headers: auditReasonHeaders(payload.reason),
  });
  // SAFETY: Discord's Modify Guild Member route returns the updated API member.
  return member as APIGuildMember;
}

export async function kickMemberDiscord(payload: DiscordModerationTarget, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.guildMember(payload.guildId, payload.userId), {
    headers: auditReasonHeaders(payload.reason),
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
    headers: auditReasonHeaders(payload.reason),
  });
  return { ok: true };
}
