import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";

const openKeyedStore = vi.hoisted(() => vi.fn((_options: OpenKeyedStoreOptions) => ({})));

vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({ state: { openKeyedStore } }),
}));

import { openDiscordPresenceCooldownStore } from "./presence-cooldown-store.js";

describe("openDiscordPresenceCooldownStore", () => {
  it("persists worker-backed cooldown claims across reopen and conditionally rolls them back", async () => {
    await withOpenClawTestState({ label: "discord-presence-cooldown" }, async () => {
      openKeyedStore.mockImplementation((options) =>
        createPluginStateKeyedStoreForTests<number>("discord", options),
      );
      const key = "default:guild-1:user-1";
      const now = Date.now();
      try {
        const store = openDiscordPresenceCooldownStore();
        expect(await store.registerIfAbsent(key, now)).toBe(true);
        resetPluginStateStoreForTests();
        const reopened = openDiscordPresenceCooldownStore();
        expect(await reopened.lookup(key)).toBe(now);
        expect(await reopened.registerIfAbsent(key, now + 1)).toBe(false);
        const persisted = (await reopened.entries()).find((entry) => entry.key === key)!;
        expect(persisted.expiresAt! - persisted.createdAt).toBe(8 * 60 * 60 * 1_000);
        expect(await reopened.deleteIfEqual?.(key, now + 1)).toBe(false);
        expect(await reopened.lookup(key)).toBe(now);
        expect(await reopened.deleteIfEqual?.(key, now)).toBe(true);
        expect(await reopened.lookup(key)).toBeUndefined();
      } finally {
        resetPluginStateStoreForTests();
        openKeyedStore.mockReset().mockReturnValue({});
      }
    });
  });

  it("preserves active cooldowns by rejecting new users at capacity", () => {
    openDiscordPresenceCooldownStore();

    expect(openKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEntries: 25_000,
        overflowPolicy: "reject-new",
      }),
    );
  });
});
