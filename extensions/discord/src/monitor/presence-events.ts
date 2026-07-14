// Discord plugin module turns selected presence transitions into routed agent events.
import type { GatewayPresenceUpdate } from "discord-api-types/v10";
import type { DiscordGuildEntryResolved } from "./allow-list.js";

export const DISCORD_PRESENCE_STARTUP_GRACE_MS = 30_000;
export const DISCORD_PRESENCE_GREETING_COOLDOWN_MS = 8 * 60 * 60 * 1000;

type PresenceEventsConfig = NonNullable<DiscordGuildEntryResolved["presenceEvents"]>;

export function isDiscordOnlineStatus(status: unknown): boolean {
  return status === "online" || status === "idle" || status === "dnd";
}

export function resolveDiscordOnlinePresenceEvent(params: {
  config: PresenceEventsConfig | undefined;
  data: GatewayPresenceUpdate;
  hadOfflineBaseline: boolean;
  botUserId?: string;
  startedAtMs: number;
  nowMs: number;
  lastEmittedAtMs?: number;
}): { channelId: string; userId: string; text: string } | null {
  const config = params.config;
  const userId = params.data.user?.id?.trim();
  if (
    !config ||
    config.enabled === false ||
    !userId ||
    userId === params.botUserId ||
    params.data.user.bot === true ||
    !isDiscordOnlineStatus(params.data.status) ||
    !params.hadOfflineBaseline
  ) {
    return null;
  }
  if (config.users !== undefined && !config.users.includes(userId)) {
    return null;
  }
  // Discord sends initial presence snapshots after connect. Even with a cached offline state,
  // suppress reconnect churn until the gateway has settled.
  if (params.nowMs - params.startedAtMs < DISCORD_PRESENCE_STARTUP_GRACE_MS) {
    return null;
  }
  if (
    params.lastEmittedAtMs !== undefined &&
    params.nowMs - params.lastEmittedAtMs < DISCORD_PRESENCE_GREETING_COOLDOWN_MS
  ) {
    return null;
  }

  const lines = [
    "Discord online-presence event:",
    `A human member came online in guild_id=${JSON.stringify(params.data.guild_id)} user_id=${JSON.stringify(userId)} status=${JSON.stringify(params.data.status)}.`,
    `The authorized greeting target is channel_id=${JSON.stringify(config.channelId)}.`,
    "Before greeting, retrieve relevant memory and wiki context for this immutable user_id, including a known timezone when available. Use their local time for the greeting; if their timezone is unknown, do not guess.",
    "Send at most one short, natural greeting to the target channel. Do not reveal private memory. If no greeting is appropriate, stay silent.",
  ];
  return { channelId: config.channelId, userId, text: lines.join("\n") };
}
