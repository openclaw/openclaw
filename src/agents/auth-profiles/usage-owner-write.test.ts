import { afterEach, describe, expect, it, vi } from "vitest";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";
import { authProfileUsageDeps, clearAuthProfileCooldown } from "./usage-owner-write.js";

describe("clearAuthProfileCooldown", () => {
  afterEach(() => {
    authProfileUsageDeps.updateAuthProfileStoreWithLock = updateAuthProfileStoreWithLock;
  });

  it("reports a dropped locked write and keeps the caller's cooldown", async () => {
    const disabledUntil = Date.now() + 60 * 60 * 1000;
    const store: AuthProfileStore = {
      version: 1,
      profiles: { "anthropic:work": { type: "api_key", provider: "anthropic", key: "sk-test" } },
      usageStats: { "anthropic:work": { disabledUntil, disabledReason: "billing" } },
    };
    authProfileUsageDeps.updateAuthProfileStoreWithLock = vi.fn(async () => null);

    await expect(clearAuthProfileCooldown({ store, profileId: "anthropic:work" })).resolves.toBe(
      false,
    );

    expect(store.usageStats?.["anthropic:work"]?.disabledUntil).toBe(disabledUntil);
  });
});
