import { beforeEach, describe, expect, it, vi } from "vitest";
import { markAuthProfileSuccess } from "./profiles.js";
import type { AuthProfileStore } from "./types.js";

const storeMocks = vi.hoisted(() => ({
  saveAuthProfileStore: vi.fn(),
  updateAuthProfileStoreWithLock: vi.fn().mockResolvedValue(null),
}));

vi.mock("./store.js", () => ({
  ensureAuthProfileStoreForLocalUpdate: vi.fn(() => ({ version: 1, profiles: {} })),
  saveAuthProfileStore: storeMocks.saveAuthProfileStore,
  updateAuthProfileStoreWithLock: storeMocks.updateAuthProfileStoreWithLock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue(null);
});

function makeStore(usageStats: AuthProfileStore["usageStats"]): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-test",
      },
    },
    usageStats,
  };
}

describe("markAuthProfileSuccess", () => {
  it("updates last-good and usage stats through the fallback save path when lock update misses", async () => {
    const store = makeStore({
      "anthropic:default": {
        errorCount: 3,
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
      },
    });

    storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue(null);

    const beforeUsed = Date.now();
    await markAuthProfileSuccess({
      store,
      provider: "anthropic",
      profileId: "anthropic:default",
      agentDir: "/tmp/openclaw-auth-profiles-success",
    });

    expect(storeMocks.saveAuthProfileStore).toHaveBeenCalledWith(
      store,
      "/tmp/openclaw-auth-profiles-success",
    );
    expect(store.lastGood).toEqual({ anthropic: "anthropic:default" });
    expect(store.usageStats?.["anthropic:default"]).toMatchObject({
      errorCount: 0,
      cooldownUntil: undefined,
      cooldownReason: undefined,
    });
    expect(store.usageStats?.["anthropic:default"]?.lastUsed).toBeGreaterThanOrEqual(beforeUsed);
  });

  it("adopts locked store last-good and usage stats without saving locally when lock update succeeds", async () => {
    const store = makeStore({
      "anthropic:default": {
        errorCount: 3,
        cooldownUntil: Date.now() + 60_000,
      },
    });
    const lockedStore = makeStore(undefined);

    storeMocks.updateAuthProfileStoreWithLock.mockImplementationOnce(async ({ updater }) => {
      updater(lockedStore);
      return lockedStore;
    });

    await markAuthProfileSuccess({
      store,
      provider: "anthropic",
      profileId: "anthropic:default",
      agentDir: "/tmp/openclaw-auth-profiles-success",
    });

    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
    expect(store.lastGood).toEqual({ anthropic: "anthropic:default" });
    expect(store.usageStats).toEqual(lockedStore.usageStats);
    expect(store.usageStats?.["anthropic:default"]).toMatchObject({
      errorCount: 0,
      cooldownUntil: undefined,
    });
    expect(store.usageStats?.["anthropic:default"]?.lastUsed).toEqual(expect.any(Number));
  });
});
