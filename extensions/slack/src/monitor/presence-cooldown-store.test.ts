import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
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
      try {
        const store = openSlackPresenceCooldownStore();
        expect(await store.registerIfAbsent("default:T123:U123", now)).toBe(true);
        resetPluginStateStoreForTests();
        const reopened = openSlackPresenceCooldownStore();
        expect(await reopened.lookup("default:T123:U123")).toBe(now);
        expect(await reopened.registerIfAbsent("default:T123:U123", now)).toBe(false);
        expect(await reopened.registerIfAbsent("default:T456:U123", now)).toBe(true);
        const persisted = (await reopened.entries()).find(
          (entry) => entry.key === "default:T123:U123",
        )!;
        expect(persisted.expiresAt! - persisted.createdAt).toBe(8 * 60 * 60 * 1_000);
        // The actor's clock is independent; expire the persisted row before the read.
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE plugin_state_entries SET expires_at = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
          )
          .run(Date.now() - 1, "slack", "presence-greeting-cooldowns", "default:T123:U123");
        expect(await reopened.lookup("default:T123:U123")).toBeUndefined();
        expect(await reopened.registerIfAbsent("default:T123:U123", now + 1)).toBe(true);
        expect(await reopened.deleteIfEqual?.("default:T123:U123", now)).toBe(false);
        expect(await reopened.lookup("default:T123:U123")).toBe(now + 1);
      } finally {
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
