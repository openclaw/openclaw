import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";
import { clearAuthProfileCooldown } from "./usage-owner-write.js";

// mock-isolation: the unit only reaches the locked writer; the full store runtime graph is unrelated.
vi.mock("./store-runtime.js", () => ({
  updateAuthProfileStoreWithLock: vi.fn(async () => null),
}));

describe("clearAuthProfileCooldown", () => {
  it("reports a dropped locked write and keeps the caller's cooldown", async () => {
    const disabledUntil = Date.now() + 60 * 60 * 1000;
    const store: AuthProfileStore = {
      version: 1,
      profiles: { "anthropic:work": { type: "api_key", provider: "anthropic", key: "sk-test" } },
      usageStats: { "anthropic:work": { disabledUntil, disabledReason: "billing" } },
    };

    await expect(clearAuthProfileCooldown({ store, profileId: "anthropic:work" })).resolves.toBe(
      false,
    );

    expect(store.usageStats?.["anthropic:work"]?.disabledUntil).toBe(disabledUntil);
  });
});
