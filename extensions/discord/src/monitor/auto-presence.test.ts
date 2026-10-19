import {
  createTestPluginServiceScheduler,
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatePresenceData } from "../internal/plugin-contract.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";

const schedulers = new Set<ReturnType<typeof createTestPluginServiceScheduler>>();
afterEach(async () => {
  await Promise.all(Array.from(schedulers, (scheduler) => scheduler.stop()));
  schedulers.clear();
});

function createController(
  params: Partial<Parameters<typeof createDiscordAutoPresenceController>[0]> = {},
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  schedulers.add(scheduler);
  const updatePresence = vi.fn();
  return {
    ...createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: { autoPresence: { enabled: true } },
      gateway: { isConnected: true, updatePresence },
      loadAuthStore: () => createStore(),
      ...params,
      scheduler,
    }),
    updatePresence,
    advance: clock.advanceBy,
  };
}

function createStore(params?: {
  cooldownUntil?: number;
  failureCounts?: Record<string, number>;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: { "openai:default": { type: "api_key", provider: "openai", key: "sk-test" } },
    usageStats: { "openai:default": { ...params } },
  };
}

function presenceUpdate(
  status: UpdatePresenceData["status"],
  activities: UpdatePresenceData["activities"] = [],
): UpdatePresenceData {
  return { since: null, activities, status, afk: false };
}

describe("discord auto presence", () => {
  it("maps overloaded cooldown to dnd", async () => {
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
    await controller.start();

    expect(updatePresence).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "dnd",
        activities: [expect.objectContaining({ state: "token exhausted" })],
      }),
    );
  });

  it("reports degraded availability when no auth profiles exist", async () => {
    const controller = createController({
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    await controller.start();
    expect(controller.updatePresence).toHaveBeenCalledWith(
      presenceUpdate("idle", [{ name: "Custom Status", type: 4, state: "runtime degraded" }]),
    );
  });

  it("clears expired cooldowns without sending presence while disconnected", async () => {
    const now = Date.now();
    const store = createStore({ cooldownUntil: now - 1, failureCounts: { rate_limit: 1 } });
    const updatePresence = vi.fn();
    const controller = createController({
      gateway: { isConnected: false, updatePresence },
      loadAuthStore: () => store,
    });
    await controller.start();
    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
    expect(updatePresence).not.toHaveBeenCalled();
  });

  it("recovers from exhausted to online once a profile becomes usable", async () => {
    const now = Date.now();
    let store = createStore({ cooldownUntil: now + 60_000, failureCounts: { rate_limit: 1 } });
    const controller = createController({
      discordConfig: {
        activity: "working",
        activityType: 0,
        autoPresence: {
          enabled: true,
          intervalMs: 5_000,
          minUpdateIntervalMs: 1_000,
        },
      },
      loadAuthStore: () => store,
    });

    await controller.start();

    store = createStore();
    await controller.advance(5_000);

    expect(controller.updatePresence.mock.calls).toEqual([
      [presenceUpdate("dnd", [{ name: "Custom Status", type: 4, state: "token exhausted" }])],
      [presenceUpdate("online", [{ name: "working", type: 0 }])],
    ]);
  });

  it("re-applies presence on refresh even when signature is unchanged", async () => {
    const controller = createController({
      discordConfig: {
        autoPresence: {
          enabled: true,
          intervalMs: 60_000,
          minUpdateIntervalMs: 60_000,
        },
      },
    });

    await controller.start();
    await controller.advance(60_000);
    expect(controller.updatePresence).toHaveBeenCalledTimes(1);
    await controller.refresh();

    const expected = presenceUpdate("online");
    expect(controller.updatePresence.mock.calls).toEqual([[expected], [expected]]);
  });

  it("does nothing when auto presence is disabled", async () => {
    const controller = createController({
      discordConfig: { autoPresence: { enabled: false } },
    });

    await controller.start();
    await controller.refresh();
    await controller.stop();

    expect(controller.enabled).toBe(false);
    expect(controller.updatePresence).not.toHaveBeenCalled();
  });
});
