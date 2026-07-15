import {
  type APIUnavailableGuild,
  type GatewayGuildCreateDispatchData,
  type GatewayPresenceUpdate,
  PresenceUpdateStatus,
} from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";
import { clearPresences } from "./presence-cache.js";
import { DiscordPresenceBaselineCache } from "./presence-transition-cache.js";

const mocks = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(() => true),
  requestHeartbeat: vi.fn(),
  resolveAgentRoute: vi.fn(() => ({
    agentId: "molty",
    sessionKey: "agent:molty:discord:channel:channel-1",
  })),
}));

vi.mock("openclaw/plugin-sdk/heartbeat-runtime", () => ({
  requestHeartbeat: mocks.requestHeartbeat,
}));
vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: mocks.resolveAgentRoute,
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

import { DiscordPresenceGuildDeleteListener, DiscordPresenceListener } from "./listeners.js";

function presence(status: "online" | "offline", userId = "user-1"): GatewayPresenceUpdate {
  return {
    guild_id: "guild-1",
    status: status === "online" ? PresenceUpdateStatus.Online : PresenceUpdateStatus.Offline,
    activities: [],
    client_status: {},
    user: { id: userId, username: "Alice" },
  };
}

function guildSnapshot(
  presences: GatewayPresenceUpdate[],
  memberCount = 100,
): GatewayGuildCreateDispatchData {
  return {
    id: "guild-1",
    member_count: memberCount,
    presences,
  } as GatewayGuildCreateDispatchData;
}

function client(bot = false): Client {
  return { fetchUser: vi.fn(async () => ({ bot })) } as unknown as Client;
}

function cooldownStore(values = new Map<string, number>()): PluginStateSyncKeyedStore<number> {
  return {
    register: (key, value) => void values.set(key, value),
    registerIfAbsent: (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: (key) => values.get(key),
    consume: (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: value })),
    clear: () => values.clear(),
  };
}

describe("DiscordPresenceListener", () => {
  beforeEach(() => {
    clearPresences();
    vi.clearAllMocks();
  });

  it("routes, queues, and wakes an offline-to-online transition", async () => {
    let nowMs = 0;
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      botUserId: "bot-1",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => nowMs,
    });

    nowMs = 30_000;
    await listener.handle(presence("offline"), client());
    nowMs = 31_000;
    await listener.handle(presence("online"), client());

    expect(mocks.resolveAgentRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "discord",
      accountId: "molty",
      guildId: "guild-1",
      peer: { kind: "channel", id: "channel-1" },
    });
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('user_id="user-1"'),
      expect.objectContaining({
        sessionKey: "agent:molty:discord:channel:channel-1",
        deliveryContext: {
          channel: "discord",
          to: "channel:channel-1",
          accountId: "molty",
        },
      }),
    );
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      agentId: "molty",
      sessionKey: "agent:molty:discord:channel:channel-1",
      heartbeat: {
        target: "discord",
        to: "channel:channel-1",
        accountId: "molty",
      },
    });
  });

  it("retries when the queue rejects an event", async () => {
    mocks.enqueueSystemEvent.mockReturnValueOnce(false);
    let nowMs = 0;
    const store = cooldownStore();
    const registerIfAbsent = vi.spyOn(store, "registerIfAbsent");
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: store,
      nowMs: () => nowMs,
    });

    nowMs = 30_000;
    await listener.handle(presence("offline"), client());
    nowMs = 31_000;
    await listener.handle(presence("online"), client());

    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    nowMs += 1000;
    await listener.handle(presence("online"), client());

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(2);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
    expect(registerIfAbsent).toHaveBeenCalledTimes(2);
  });

  it("skips a wake when the durable cooldown cannot be reserved", async () => {
    let nowMs = 0;
    const store = cooldownStore();
    vi.spyOn(store, "registerIfAbsent").mockImplementation(() => {
      throw new Error("capacity");
    });
    const warn = vi.fn();
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      logger: { warn } as never,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: store,
      nowMs: () => nowMs,
    });

    nowMs = 30_000;
    await listener.handle(presence("offline"), client());
    nowMs += 1000;
    await listener.handle(presence("online"), client());

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cooldown persistence failed"));
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("uses the guild snapshot to classify the first live presence update", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => 1_000,
    });
    const humanClient = client();

    listener.seedGuildSnapshot(guildSnapshot([presence("online", "already-online")]));
    await listener.handle(presence("online", "already-online"), humanClient);
    await listener.handle(presence("online", "came-online"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('user_id="came-online"'),
      expect.anything(),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("may have come online or joined after the snapshot"),
      expect.anything(),
    );
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit offline update after an incomplete large-guild snapshot", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => 1_000,
    });
    const humanClient = client();

    listener.seedGuildSnapshot(guildSnapshot([], 75_001));
    await listener.handle(presence("online", "large-guild-member"), humanClient);
    await listener.handle(presence("offline", "large-guild-member"), humanClient);
    await listener.handle(presence("online", "large-guild-member"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("disables snapshot-absence inference after bounded baseline eviction", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      presenceBaseline: new DiscordPresenceBaselineCache(1),
      nowMs: () => 1_000,
    });
    const humanClient = client();

    listener.seedGuildSnapshot(
      guildSnapshot([presence("online", "first"), presence("online", "second")]),
    );
    await listener.handle(presence("online", "unknown"), humanClient);
    await listener.handle(presence("offline", "unknown"), humanClient);
    await listener.handle(presence("online", "unknown"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("keeps complete snapshot inference isolated per guild", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
        "guild-2": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      presenceBaseline: new DiscordPresenceBaselineCache(1),
      nowMs: () => 1_000,
    });
    const humanClient = client();

    listener.seedGuildSnapshot(guildSnapshot([]));
    listener.seedGuildSnapshot({ ...guildSnapshot([], 75_001), id: "guild-2" });
    await listener.handle({ ...presence("online", "busy-1"), guild_id: "guild-2" }, humanClient);
    await listener.handle({ ...presence("online", "busy-2"), guild_id: "guild-2" }, humanClient);
    await listener.handle(presence("online", "quiet-arrival"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('user_id="quiet-arrival"'),
      expect.anything(),
    );
  });

  it("ignores unavailable snapshots and invalidates in-flight work on replacement", async () => {
    for (const bot of [false, true]) {
      const listener = new DiscordPresenceListener({
        cfg: {} as OpenClawConfig,
        accountId: "molty",
        guildEntries: {
          "guild-1": { presenceEvents: { channelId: "channel-1" } },
        },
        cooldownStore: cooldownStore(),
        nowMs: () => 1_000,
      });
      let resolveFetch: ((value: { bot: boolean }) => void) | undefined;
      const fetchUser = vi.fn(
        () =>
          new Promise<{ bot: boolean }>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const partialOnline = { ...presence("online"), user: { id: "user-1" } };

      listener.seedGuildSnapshot(guildSnapshot([]));
      const pending = listener.handle(partialOnline, { fetchUser } as unknown as Client);
      await vi.waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(1));
      listener.seedGuildSnapshot({ id: "guild-1", unavailable: true } as APIUnavailableGuild);
      listener.seedGuildSnapshot(guildSnapshot([presence("online")]));
      resolveFetch?.({ bot });
      await pending;
    }

    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("detaches replacement-snapshot work from stale in-flight lookups", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => 1_000,
    });
    const resolvers: Array<(value: { bot: boolean }) => void> = [];
    const fetchUser = vi.fn(
      () =>
        new Promise<{ bot: boolean }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const partialOnline = { ...presence("online"), user: { id: "user-1" } };

    listener.seedGuildSnapshot(guildSnapshot([]));
    const stale = listener.handle(partialOnline, { fetchUser } as unknown as Client);
    await vi.waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(1));
    listener.seedGuildSnapshot(guildSnapshot([]));
    const current = listener.handle(partialOnline, { fetchUser } as unknown as Client);
    await vi.waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(2));

    resolvers[1]?.({ bot: false });
    await current;
    resolvers[0]?.({ bot: false });
    await stale;

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("detaches replacement-session work from stale in-flight lookups", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => 1_000,
    });
    const resolvers: Array<(value: { bot: boolean }) => void> = [];
    const fetchUser = vi.fn(
      () =>
        new Promise<{ bot: boolean }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const partialOnline = { ...presence("online"), user: { id: "user-1" } };

    listener.seedGuildSnapshot(guildSnapshot([]));
    const stale = listener.handle(partialOnline, { fetchUser } as unknown as Client);
    await vi.waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(1));
    listener.resetGatewaySession();
    listener.seedGuildSnapshot(guildSnapshot([]));
    const current = listener.handle(partialOnline, { fetchUser } as unknown as Client);
    await vi.waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(2));

    resolvers[1]?.({ bot: false });
    await current;
    resolvers[0]?.({ bot: false });
    await stale;

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("invalidates in-flight work when Discord deletes a guild", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => 1_000,
    });
    let resolveFetch: ((value: { bot: boolean }) => void) | undefined;
    const fetchUser = vi.fn(
      () =>
        new Promise<{ bot: boolean }>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const partialOnline = { ...presence("online"), user: { id: "user-1" } };

    listener.seedGuildSnapshot(guildSnapshot([]));
    const pending = listener.handle(partialOnline, { fetchUser } as unknown as Client);
    await vi.waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(1));
    new DiscordPresenceGuildDeleteListener(listener).handle({ id: "guild-1" });
    resolveFetch?.({ bot: false });
    await pending;

    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("does not let excluded users consume bounded baseline state", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": {
          presenceEvents: { channelId: "channel-1", users: ["allowed"] },
        },
      },
      cooldownStore: cooldownStore(),
      presenceBaseline: new DiscordPresenceBaselineCache(1),
      nowMs: () => 1_000,
    });
    const humanClient = client();

    listener.seedGuildSnapshot(guildSnapshot([]));
    await listener.handle(presence("online", "excluded-1"), humanClient);
    await listener.handle(presence("online", "excluded-2"), humanClient);
    await listener.handle(presence("online", "allowed"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('user_id="allowed"'),
      expect.anything(),
    );
  });

  it("protects explicit offline evidence from unrelated online churn", async () => {
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      presenceBaseline: new DiscordPresenceBaselineCache(1),
      nowMs: () => 1_000,
    });
    const humanClient = client();

    listener.seedGuildSnapshot(guildSnapshot([], 75_001));
    await listener.handle(presence("offline", "target"), humanClient);
    await listener.handle(presence("online", "churn-1"), humanClient);
    await listener.handle(presence("online", "churn-2"), humanClient);
    await listener.handle(presence("online", "target"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('user_id="target"'),
      expect.anything(),
    );
  });

  it("keeps transition state per guild and rejects bots from partial payloads", async () => {
    let nowMs = 0;
    const store = cooldownStore();
    const register = vi.spyOn(store, "register");
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: store,
      nowMs: () => nowMs,
    });
    const fetchUser = vi.fn(async () => ({ bot: true }));
    const botClient = { fetchUser } as unknown as Client;

    nowMs = 30_000;
    await listener.handle({ ...presence("online"), guild_id: "guild-2" }, botClient);
    nowMs += 1000;
    await listener.handle(presence("offline"), botClient);
    nowMs += 1000;
    await listener.handle(presence("online"), botClient);

    expect(fetchUser).toHaveBeenCalledWith("user-1");
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("does not let another guild's status suppress the configured guild", async () => {
    let nowMs = 0;
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => nowMs,
    });
    const humanClient = client();

    nowMs = 30_000;
    await listener.handle(presence("offline"), humanClient);
    await listener.handle({ ...presence("online"), guild_id: "guild-2" }, humanClient);
    nowMs += 1000;
    await listener.handle(presence("online"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("drops offline baselines when the gateway session resets", async () => {
    let nowMs = 0;
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => nowMs,
    });
    const humanClient = client();

    nowMs = 30_000;
    await listener.handle(presence("offline"), humanClient);
    nowMs += 1000;
    listener.resetGatewaySession();
    nowMs += 30_000;
    await listener.handle(presence("online"), humanClient);

    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("retries a partial-user transition after a transient lookup failure", async () => {
    let nowMs = 0;
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => nowMs,
    });
    const fetchUser = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue({ bot: false });
    const retryClient = { fetchUser } as unknown as Client;
    const partialOnline = { ...presence("online"), user: { id: "user-1" } };

    nowMs = 30_000;
    await listener.handle(presence("offline"), retryClient);
    nowMs += 1000;
    await listener.handle(partialOnline, retryClient);
    nowMs += 1000;
    await listener.handle(partialOnline, retryClient);

    expect(fetchUser).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("serializes rapid transitions while a partial-user lookup is pending", async () => {
    let nowMs = 0;
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
      },
      cooldownStore: cooldownStore(),
      nowMs: () => nowMs,
    });
    const humanClient = client();
    const partialOnline = { ...presence("online"), user: { id: "user-1" } };

    nowMs = 30_000;
    await listener.handle(presence("offline"), humanClient);
    nowMs += 1000;
    const firstOnline = listener.handle(partialOnline, humanClient);
    nowMs += 1000;
    const offline = listener.handle(presence("offline"), humanClient);
    nowMs += 1000;
    const secondOnline = listener.handle(partialOnline, humanClient);
    await Promise.all([firstOnline, offline, secondOnline]);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("atomically claims a cooldown across overlapping listener generations", async () => {
    let nowMs = 0;
    const sharedCooldownStore = cooldownStore();
    const createListener = () =>
      new DiscordPresenceListener({
        cfg: {} as OpenClawConfig,
        accountId: "molty",
        guildEntries: {
          "guild-1": { presenceEvents: { channelId: "channel-1" } },
        },
        cooldownStore: sharedCooldownStore,
        nowMs: () => nowMs,
      });
    const firstListener = createListener();
    const replacementListener = createListener();

    nowMs = 30_000;
    await firstListener.handle(presence("offline"), client());
    await replacementListener.handle(presence("offline"), client());

    let resolveUser!: (value: { bot: boolean }) => void;
    const fetchedUser = new Promise<{ bot: boolean }>((resolve) => {
      resolveUser = resolve;
    });
    const fetchUser = vi.fn(() => fetchedUser);
    const overlappingClient = { fetchUser } as unknown as Client;
    const partialOnline = { ...presence("online"), user: { id: "user-1" } };

    nowMs += 1000;
    const firstOnline = firstListener.handle(partialOnline, overlappingClient);
    const replacementOnline = replacementListener.handle(partialOnline, overlappingClient);
    await vi.waitFor(() => expect(fetchUser).toHaveBeenCalledTimes(2));
    resolveUser({ bot: false });
    await Promise.all([firstOnline, replacementOnline]);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("keeps the cooldown when the listener is recreated", async () => {
    let nowMs = 0;
    const sharedCooldownStore = cooldownStore();
    const createListener = () =>
      new DiscordPresenceListener({
        cfg: {} as OpenClawConfig,
        accountId: "molty",
        guildEntries: {
          "guild-1": { presenceEvents: { channelId: "channel-1" } },
        },
        nowMs: () => nowMs,
        cooldownStore: sharedCooldownStore,
      });
    const humanClient = client();
    const firstListener = createListener();

    nowMs = 30_000;
    await firstListener.handle(presence("offline"), humanClient);
    nowMs += 1000;
    await firstListener.handle(presence("online"), humanClient);

    const secondListener = createListener();
    nowMs += 30_000;
    await secondListener.handle(presence("offline"), humanClient);
    nowMs += 1000;
    await secondListener.handle(presence("online"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("scopes persisted cooldowns by Discord account", async () => {
    let nowMs = 0;
    const sharedCooldownStore = cooldownStore();
    const createListener = (accountId: string) =>
      new DiscordPresenceListener({
        cfg: {} as OpenClawConfig,
        accountId,
        guildEntries: {
          "guild-1": { presenceEvents: { channelId: "channel-1" } },
        },
        nowMs: () => nowMs,
        cooldownStore: sharedCooldownStore,
      });
    const humanClient = client();
    const firstAccount = createListener("first");
    const secondAccount = createListener("second");

    nowMs = 30_000;
    await firstAccount.handle(presence("offline"), humanClient);
    await secondAccount.handle(presence("offline"), humanClient);
    nowMs += 1000;
    await firstAccount.handle(presence("online"), humanClient);
    await secondAccount.handle(presence("online"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(2);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(2);
  });
});
