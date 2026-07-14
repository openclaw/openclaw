import type { GatewayPresenceUpdate } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";
import { clearPresences } from "./presence-cache.js";

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

import { DiscordPresenceListener } from "./listeners.js";

function presence(status: "online" | "offline"): GatewayPresenceUpdate {
  return {
    guild_id: "guild-1",
    status,
    activities: [],
    client_status: {},
    user: { id: "user-1", username: "Alice" },
  };
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
        trusted: false,
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
      reason: "discord-presence-online",
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
    const listener = new DiscordPresenceListener({
      cfg: {} as OpenClawConfig,
      accountId: "molty",
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

    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    nowMs += 1000;
    await listener.handle(presence("online"), client());

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(2);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("keeps transition state per guild and rejects bots from partial payloads", async () => {
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
    const botClient = client(true);

    nowMs = 30_000;
    await listener.handle({ ...presence("online"), guild_id: "guild-2" }, botClient);
    nowMs += 1000;
    await listener.handle(presence("offline"), botClient);
    nowMs += 1000;
    await listener.handle(presence("online"), botClient);

    expect(botClient.fetchUser).toHaveBeenCalledWith("user-1");
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
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
    const retryClient = {
      fetchUser: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValue({ bot: false }),
    } as unknown as Client;
    const partialOnline = { ...presence("online"), user: { id: "user-1" } };

    nowMs = 30_000;
    await listener.handle(presence("offline"), retryClient);
    nowMs += 1000;
    await listener.handle(partialOnline, retryClient);
    nowMs += 1000;
    await listener.handle(partialOnline, retryClient);

    expect(retryClient.fetchUser).toHaveBeenCalledTimes(2);
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
