import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNextcloudTalkWebhook } from "./monitor.js";

afterEach(() => vi.useRealTimers());

describe("Nextcloud Talk shared webhook lifetime", () => {
  it("keeps the route and limiter until its last account stops, then releases both", async () => {
    vi.useFakeTimers();
    const registry = createTestRegistry();
    setActivePluginRegistry(registry);
    const baselineTimerCount = vi.getTimerCount();
    const target = { path: "/w", secret: "s", onWebhook: async () => "ignored" as const };
    const first = registerNextcloudTalkWebhook(target);
    const second = registerNextcloudTalkWebhook({ ...target, secret: "other" });
    expect(registry.httpRoutes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    const legacyTarget = { ...target, legacyListener: { port: 8788, host: "127.0.0.1" } };
    const firstLegacy = registerNextcloudTalkWebhook(legacyTarget);
    const secondLegacy = registerNextcloudTalkWebhook({
      ...legacyTarget,
      path: "/other",
      secret: "other",
    });
    expect(registry.httpRoutes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 3);
    await firstLegacy();
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 3);
    await secondLegacy();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    await first();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
    await second();
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
    await second();
    expect(registry.httpRoutes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
  });
});
