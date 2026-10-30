import { type GatewayPresenceUpdate, PresenceUpdateStatus } from "discord-api-types/v10";
import { expect, it } from "vitest";
import {
  DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
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
type EventParams = Parameters<typeof resolveDiscordOnlinePresenceEvent>[0];
function resolve(overrides: Partial<EventParams> = {}) {
  return resolveDiscordOnlinePresenceEvent({
    config,
    data: presence("online"),
    availabilityKind: "observed-offline",
    nowMs: 1_000,
    ...overrides,
  });
}

it("emits for an observed offline-to-online human transition", () => {
  const result = resolve({
    data: presence("online", { global_name: "Alice Example" }),
    botUserId: "bot-1",
  });

  expect(result).toMatchObject({ channelId: "channel-1", userId: "user-1" });
  expect(result?.text).toContain('user_id="user-1"');
  expect(result?.text).not.toContain("Alice Example");
  expect(result?.text).toContain("retrieve relevant memory and wiki context");
  expect(result?.text).toContain("after being observed offline");
});

it("does not overstate prior status for first-seen members", () => {
  const result = resolve({ availabilityKind: "first-seen-after-snapshot" });

  expect(result?.text).toContain("may have come online or joined after the snapshot");
  expect(result?.text).toContain("do not claim an exact prior status");
});

it("suppresses unchanged online states", () => {
  expect(resolve({ availabilityKind: null })).toBeNull();
  expect(resolve({ data: presence("idle"), availabilityKind: null })).toBeNull();
});

it("honors immutable user allowlists, bot exclusion, and cooldown", () => {
  const base = { nowMs: DISCORD_PRESENCE_GREETING_COOLDOWN_MS };
  expect(resolve({ ...base, config: { ...config, users: ["other"] } })).toBeNull();
  expect(resolve({ ...base, config: { ...config, users: [] } })).toBeNull();
  expect(resolve({ ...base, data: presence("online", { bot: true }) })).toBeNull();
  expect(resolve({ ...base, lastEmittedAtMs: 1 })).toBeNull();
});
