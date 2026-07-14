import { type GatewayPresenceUpdate, PresenceUpdateStatus } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
  DISCORD_PRESENCE_STARTUP_GRACE_MS,
  resolveDiscordOnlinePresenceEvent,
} from "./presence-events.js";

function presence(
  status: "online" | "idle" | "dnd" | "offline",
  overrides: Partial<GatewayPresenceUpdate["user"]> = {},
): GatewayPresenceUpdate {
  const statuses = {
    online: PresenceUpdateStatus.Online,
    idle: PresenceUpdateStatus.Idle,
    dnd: PresenceUpdateStatus.DoNotDisturb,
    offline: PresenceUpdateStatus.Offline,
  } as const;
  return {
    guild_id: "guild-1",
    status: statuses[status],
    activities: [],
    client_status: {},
    user: { id: "user-1", username: "Alice", ...overrides },
  };
}

const config = { channelId: "channel-1" };

describe("resolveDiscordOnlinePresenceEvent", () => {
  it("emits only for an offline-to-online human transition", () => {
    const result = resolveDiscordOnlinePresenceEvent({
      config,
      data: presence("online", { global_name: "Alice Example" }),
      hadOfflineBaseline: true,
      botUserId: "bot-1",
      startedAtMs: 0,
      nowMs: DISCORD_PRESENCE_STARTUP_GRACE_MS,
    });

    expect(result).toMatchObject({ channelId: "channel-1", userId: "user-1" });
    expect(result?.text).toContain('user_id="user-1"');
    expect(result?.text).not.toContain("Alice Example");
    expect(result?.text).toContain("retrieve relevant memory and wiki context");
  });

  it("suppresses reconnect snapshots and unchanged online states", () => {
    expect(
      resolveDiscordOnlinePresenceEvent({
        config,
        data: presence("online"),
        hadOfflineBaseline: false,
        startedAtMs: 1000,
        nowMs: 1000 + DISCORD_PRESENCE_STARTUP_GRACE_MS - 1,
      }),
    ).toBeNull();
    expect(
      resolveDiscordOnlinePresenceEvent({
        config,
        data: presence("idle"),
        hadOfflineBaseline: false,
        startedAtMs: 0,
        nowMs: DISCORD_PRESENCE_STARTUP_GRACE_MS,
      }),
    ).toBeNull();
  });

  it("rejects a first observed online state after startup without an offline baseline", () => {
    expect(
      resolveDiscordOnlinePresenceEvent({
        config,
        data: presence("online"),
        hadOfflineBaseline: false,
        startedAtMs: 0,
        nowMs: DISCORD_PRESENCE_STARTUP_GRACE_MS,
      }),
    ).toBeNull();
  });

  it("honors immutable user allowlists, bot exclusion, and cooldown", () => {
    const base = {
      data: presence("online"),
      hadOfflineBaseline: true,
      startedAtMs: 0,
      nowMs: DISCORD_PRESENCE_STARTUP_GRACE_MS,
    };
    expect(
      resolveDiscordOnlinePresenceEvent({ ...base, config: { ...config, users: ["other"] } }),
    ).toBeNull();
    expect(
      resolveDiscordOnlinePresenceEvent({ ...base, config: { ...config, users: [] } }),
    ).toBeNull();
    expect(
      resolveDiscordOnlinePresenceEvent({
        ...base,
        config,
        data: presence("online", { bot: true }),
      }),
    ).toBeNull();
    expect(
      resolveDiscordOnlinePresenceEvent({
        ...base,
        config,
        lastEmittedAtMs:
          DISCORD_PRESENCE_STARTUP_GRACE_MS - DISCORD_PRESENCE_GREETING_COOLDOWN_MS + 1,
      }),
    ).toBeNull();
  });
});
