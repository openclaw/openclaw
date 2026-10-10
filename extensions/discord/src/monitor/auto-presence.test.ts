import {
  createTestPluginServiceScheduler,
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
// Discord tests cover auto presence plugin behavior.
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordAutoPresenceController } from "./auto-presence.js";

const schedulers = new Set<ReturnType<typeof createTestPluginServiceScheduler>>();
afterEach(async () => {
  await Promise.all(Array.from(schedulers, (scheduler) => scheduler.stop()));
  schedulers.clear();
});

function createController(
  params: Omit<Parameters<typeof createDiscordAutoPresenceController>[0], "scheduler">,
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  schedulers.add(scheduler);
  return {
    ...createDiscordAutoPresenceController({ ...params, scheduler }),
    advance: clock.advanceBy,
  };
}

function createStore(params?: {
  cooldownUntil?: number;
  failureCounts?: Record<string, number>;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    },
    usageStats: {
      "openai:default": {
        ...(typeof params?.cooldownUntil === "number"
          ? { cooldownUntil: params.cooldownUntil }
          : {}),
        ...(params?.failureCounts ? { failureCounts: params.failureCounts } : {}),
      },
    },
  };
}

describe("discord auto presence", () => {
  it("maps overloaded cooldown to dnd", () => {
    const now = Date.now();
    const updatePresence = vi.fn();
    const controller = createController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: true,
        },
      },
      gateway: { isConnected: true, updatePresence },
      loadAuthStore: () =>
        createStore({ cooldownUntil: now + 60_000, failureCounts: { overloaded: 2 } }),
    });
    controller.start();

    expect(updatePresence).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "dnd",
        activities: [expect.objectContaining({ state: "token exhausted" })],
      }),
    );
  });

  it("reports degraded availability when no auth profiles exist", () => {
    const updatePresence = vi.fn();
    const controller = createController({
      accountId: "default",
      discordConfig: { autoPresence: { enabled: true } },
      gateway: { isConnected: true, updatePresence },
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    controller.start();
    expect(updatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "Custom Status", type: 4, state: "runtime degraded" }],
      status: "idle",
      afk: false,
    });
  });

  it("clears expired cooldowns without sending presence while disconnected", () => {
    const now = Date.now();
    const store = createStore({ cooldownUntil: now - 1, failureCounts: { rate_limit: 1 } });
    const updatePresence = vi.fn();
    const controller = createController({
      accountId: "default",
      discordConfig: { autoPresence: { enabled: true } },
      gateway: { isConnected: false, updatePresence },
      loadAuthStore: () => store,
    });
    controller.start();
    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
    expect(updatePresence).not.toHaveBeenCalled();
  });

  it("recovers from exhausted to online once a profile becomes usable", async () => {
    const now = Date.now();
    let store = createStore({ cooldownUntil: now + 60_000, failureCounts: { rate_limit: 1 } });
    const updatePresence = vi.fn();
    const controller = createController({
      accountId: "default",
      discordConfig: {
        activity: "working",
        activityType: 0,
        autoPresence: {
          enabled: true,
          intervalMs: 5_000,
          minUpdateIntervalMs: 1_000,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => store,
    });

    controller.start();

    store = createStore();
    await controller.advance(5_000);

    expect(updatePresence).toHaveBeenCalledTimes(2);
    expect(updatePresence.mock.calls).toEqual([
      [
        {
          since: null,
          activities: [{ name: "Custom Status", type: 4, state: "token exhausted" }],
          status: "dnd",
          afk: false,
        },
      ],
      [
        {
          since: null,
          activities: [{ name: "working", type: 0 }],
          status: "online",
          afk: false,
        },
      ],
    ]);
  });

  it("re-applies presence on refresh even when signature is unchanged", async () => {
    const store = createStore();
    const updatePresence = vi.fn();

    const controller = createController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: true,
          intervalMs: 60_000,
          minUpdateIntervalMs: 60_000,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => store,
    });

    controller.start();
    await controller.advance(60_000);
    expect(updatePresence).toHaveBeenCalledTimes(1);
    controller.refresh();

    expect(updatePresence).toHaveBeenCalledTimes(2);
    expect(updatePresence.mock.calls).toEqual([
      [
        {
          since: null,
          activities: [],
          status: "online",
          afk: false,
        },
      ],
      [
        {
          since: null,
          activities: [],
          status: "online",
          afk: false,
        },
      ],
    ]);
  });

  it("does nothing when auto presence is disabled", async () => {
    const updatePresence = vi.fn();
    const controller = createController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: false,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => createStore(),
    });

    controller.start();
    controller.refresh();
    await controller.stop();

    expect(controller.enabled).toBe(false);
    expect(updatePresence).not.toHaveBeenCalled();
  });
});
