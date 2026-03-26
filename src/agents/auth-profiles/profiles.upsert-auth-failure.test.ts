import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  saveAuthProfileStore: vi.fn(),
  updateAuthProfileStoreWithLock: vi.fn(),
}));

vi.mock("./store.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  saveAuthProfileStore: mocks.saveAuthProfileStore,
  updateAuthProfileStoreWithLock: mocks.updateAuthProfileStoreWithLock,
}));

import { upsertAuthProfile, upsertAuthProfileWithLock } from "./profiles.js";

function makeStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
    usageStats: {
      "anthropic:default": {
        disabledUntil: Date.now() + 60_000,
        disabledReason: "auth_permanent",
        cooldownUntil: Date.now() + 30_000,
        errorCount: 4,
        failureCounts: { auth_permanent: 4 },
        lastUsed: 111,
        lastFailureAt: 222,
      },
    },
  };
}

describe("upsertAuthProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears stale auth failure state when fresh credentials are written", () => {
    const store = makeStore();
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    upsertAuthProfile({
      profileId: "anthropic:default",
      credential: {
        type: "oauth",
        provider: "anthropic",
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: Date.now() + 60_000,
      },
    });

    expect(store.usageStats?.["anthropic:default"]).toMatchObject({
      cooldownUntil: undefined,
      disabledUntil: undefined,
      disabledReason: undefined,
      errorCount: 0,
      failureCounts: undefined,
      lastUsed: 111,
      lastFailureAt: 222,
    });
    expect(mocks.saveAuthProfileStore).toHaveBeenCalledOnce();
  });
});

describe("upsertAuthProfileWithLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears stale auth failure state inside the locked updater", async () => {
    const store = makeStore();
    mocks.updateAuthProfileStoreWithLock.mockImplementation(async ({ updater }) => {
      updater(store);
      return store;
    });

    await upsertAuthProfileWithLock({
      profileId: "anthropic:default",
      credential: {
        type: "oauth",
        provider: "anthropic",
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: Date.now() + 60_000,
      },
    });

    expect(store.usageStats?.["anthropic:default"]).toMatchObject({
      cooldownUntil: undefined,
      disabledUntil: undefined,
      disabledReason: undefined,
      errorCount: 0,
      failureCounts: undefined,
      lastUsed: 111,
      lastFailureAt: 222,
    });
  });
});
