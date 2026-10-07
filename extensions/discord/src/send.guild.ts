import type {
  APIGuild,
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
  getGuildMember,
  getGuildVoiceState,
  isUnknownDiscordVoiceStateError,
  type APIChannel,
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

function readDiscordResource<T extends object>(route: (id: string) => string) {
  return async (id: string, opts: DiscordReactOpts): Promise<T> => {
    const rest = resolveDiscordRest(opts);
    // The REST client parses unknown JSON; each binding selects Discord's response type.
    return (await rest.get(route(id))) as T;
  };
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

export const fetchRoleInfoDiscord = readDiscordResource<APIRole[]>(Routes.guildRoles);

function roleMutation(method: "put" | "delete") {
  return async (payload: DiscordRoleChange, opts: DiscordReactOpts) => {
    const rest = resolveDiscordRest(opts);
    await rest[method](Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId));
    return { ok: true };
  };
}

export const addRoleDiscord = roleMutation("put");
export const removeRoleDiscord = roleMutation("delete");

export const fetchChannelInfoDiscord = readDiscordResource<APIChannel>(Routes.channel);

export const fetchGuildInfoDiscord = readDiscordResource<APIGuild>(Routes.guild);

export const listGuildChannelsDiscord = readDiscordResource<APIChannel[]>(Routes.guildChannels);

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

export const listScheduledEventsDiscord = readDiscordResource<APIGuildScheduledEvent[]>(
  Routes.guildScheduledEvents,
);

export async function resolveEventCoverImage(
  imageUrl: string,
  opts?: DiscordOutboundMediaOpts,
): Promise<string> {
  const { media, contentType } = await loadDiscordMediaForUpload(
    imageUrl,
    opts,
    DISCORD_MAX_EVENT_COVER_BYTES,
    DISCORD_IMAGE_UPLOAD_TYPES,
    (contentType) =>
      `Discord event cover images must be PNG, JPG, or GIF (got ${contentType ?? "unknown"})`,
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
