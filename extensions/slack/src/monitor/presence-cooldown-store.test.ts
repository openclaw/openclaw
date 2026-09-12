import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";

const openKeyedStore = vi.hoisted(() => vi.fn((_options: OpenKeyedStoreOptions) => ({})));

vi.mock("../runtime.js", () => ({
  getSlackRuntime: () => ({ state: { openKeyedStore } }),
}));

import { openSlackPresenceCooldownStore } from "./presence-cooldown-store.js";

describe("openSlackPresenceCooldownStore", () => {
  it("retains cooldowns across a SQLite reopen and expires them after eight hours", async () => {
    await withOpenClawTestState({ label: "slack-presence-cooldown" }, async () => {
      openKeyedStore.mockImplementation((options) =>
        createPluginStateKeyedStoreForTests<number>("slack", options),
      );
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const store = openSlackPresenceCooldownStore();
        expect(await store.registerIfAbsent("default:T123:U123", now)).toBe(true);
        resetPluginStateStoreForTests();
        const reopened = openSlackPresenceCooldownStore();
        expect(await reopened.lookup("default:T123:U123")).toBe(now);
        expect(await reopened.registerIfAbsent("default:T123:U123", now)).toBe(false);
        expect(await reopened.registerIfAbsent("default:T456:U123", now)).toBe(true);
        clock.mockReturnValue(now + 8 * 60 * 60 * 1_000 - 1);
        expect(await reopened.lookup("default:T123:U123")).toBe(now);
        clock.mockReturnValue(now + 8 * 60 * 60 * 1_000);
        expect(await reopened.lookup("default:T123:U123")).toBeUndefined();
        expect(await reopened.registerIfAbsent("default:T123:U123", now + 1)).toBe(true);
        expect(await reopened.deleteIf?.("default:T123:U123", (value) => value === now)).toBe(
          false,
        );
        expect(await reopened.lookup("default:T123:U123")).toBe(now + 1);
      } finally {
        clock.mockRestore();
        resetPluginStateStoreForTests();
        openKeyedStore.mockReset().mockReturnValue({});
      }
    });
  });

  it("preserves active cooldowns by rejecting new users at capacity", () => {
    openSlackPresenceCooldownStore();

    expect(openKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEntries: 25_000,
        overflowPolicy: "reject-new",
      }),
    );
  });
});
