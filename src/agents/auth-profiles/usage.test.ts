import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import {
  clearAuthProfileCooldown,
  clearExpiredCooldowns,
  isProfileInCooldown,
  markAuthProfileFailure,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntil,
  resolveProfileUnusableUntilForDisplay,
} from "./usage.js";

vi.mock("./store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./store.js")>();
  return {
    ...original,
    updateAuthProfileStoreWithLock: vi.fn().mockResolvedValue(null),
    saveAuthProfileStore: vi.fn(),
  };
});

function makeStore(usageStats: AuthProfileStore["usageStats"]): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test-2" },
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or-test" },
    },
    usageStats,
  };
}

function expectProfileErrorStateCleared(
  stats: NonNullable<AuthProfileStore["usageStats"]>[string] | undefined,
) {
  expect(stats?.cooldownUntil).toBeUndefined();
  expect(stats?.disabledUntil).toBeUndefined();
  expect(stats?.disabledReason).toBeUndefined();
  expect(stats?.errorCount).toBe(0);
  expect(stats?.failureCounts).toBeUndefined();
}

describe("resolveProfileUnusableUntil", () => {
  it("returns null when both values are missing or invalid", () => {
    expect(resolveProfileUnusableUntil({})).toBeNull();
    expect(resolveProfileUnusableUntil({ cooldownUntil: 0, disabledUntil: Number.NaN })).toBeNull();
  });

  it("returns the latest active timestamp", () => {
    expect(resolveProfileUnusableUntil({ cooldownUntil: 100, disabledUntil: 200 })).toBe(200);
    expect(resolveProfileUnusableUntil({ cooldownUntil: 300 })).toBe(300);
  });
});

describe("resolveProfileUnusableUntilForDisplay", () => {
  it("hides cooldown markers for OpenRouter profiles", () => {
    const store = makeStore({
      "openrouter:default": {
        cooldownUntil: Date.now() + 60_000,
      },
    });

    expect(resolveProfileUnusableUntilForDisplay(store, "openrouter:default")).toBeNull();
  });

  it("keeps cooldown markers visible for other providers", () => {
    const until = Date.now() + 60_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: until,
      },
    });

    expect(resolveProfileUnusableUntilForDisplay(store, "anthropic:default")).toBe(until);
  });
});

// ---------------------------------------------------------------------------
// isProfileInCooldown
// ---------------------------------------------------------------------------

describe("isProfileInCooldown", () => {
  it("returns false when profile has no usage stats", () => {
    const store = makeStore(undefined);
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(false);
  });

  it("returns true when cooldownUntil is in the future", () => {
    const store = makeStore({
      "anthropic:default": { cooldownUntil: Date.now() + 60_000 },
    });
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(true);
  });

  it("returns false when cooldownUntil has passed", () => {
    const store = makeStore({
      "anthropic:default": { cooldownUntil: Date.now() - 1_000 },
    });
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(false);
  });

  it("returns true when disabledUntil is in the future (even if cooldownUntil expired)", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        disabledUntil: Date.now() + 60_000,
      },
    });
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(true);
  });

  it("returns false for OpenRouter even when cooldown fields exist", () => {
    const store = makeStore({
      "openrouter:default": {
        cooldownUntil: Date.now() + 60_000,
        disabledUntil: Date.now() + 60_000,
        disabledReason: "billing",
      },
    });
    expect(isProfileInCooldown(store, "openrouter:default")).toBe(false);
  });
});

describe("resolveProfilesUnavailableReason", () => {
  it("prefers active disabledReason when profiles are disabled", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        disabledUntil: now + 60_000,
        disabledReason: "billing",
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("billing");
  });

  it("returns auth_permanent for active permanent auth disables", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        disabledUntil: now + 60_000,
        disabledReason: "auth_permanent",
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("auth_permanent");
  });

  it("uses recorded non-rate-limit failure counts for active cooldown windows", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        failureCounts: { auth: 3, rate_limit: 1 },
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("auth");
  });

  it("falls back to rate_limit when active cooldown has no reason history", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("rate_limit");
  });

  it("ignores expired windows and returns null when no profile is actively unavailable", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now - 1_000,
        failureCounts: { auth: 5 },
      },
      "anthropic:backup": {
        disabledUntil: now - 500,
        disabledReason: "billing",
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default", "anthropic:backup"],
        now,
      }),
    ).toBeNull();
  });

  it("breaks ties by reason priority for equal active failure counts", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        failureCounts: { timeout: 2, auth: 2 },
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// clearExpiredCooldowns
// ---------------------------------------------------------------------------

describe("clearExpiredCooldowns", () => {
  it("returns false on empty usageStats", () => {
    const store = makeStore(undefined);
    expect(clearExpiredCooldowns(store)).toBe(false);
  });

  it("returns false when no profiles have cooldowns", () => {
    const store = makeStore({
      "anthropic:default": { lastUsed: Date.now() },
    });
    expect(clearExpiredCooldowns(store)).toBe(false);
  });

  it("returns false when cooldown is still active", () => {
    const future = Date.now() + 300_000;
    const store = makeStore({
      "anthropic:default": { cooldownUntil: future, errorCount: 3 },
    });

    expect(clearExpiredCooldowns(store)).toBe(false);
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBe(future);
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(3);
  });

  it("clears expired cooldownUntil and resets errorCount", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        errorCount: 4,
        failureCounts: { rate_limit: 3, timeout: 1 },
        lastFailureAt: Date.now() - 120_000,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.cooldownUntil).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toBeUndefined();
    // lastFailureAt preserved for failureWindowMs decay
    expect(stats?.lastFailureAt).toBeDefined();
  });

  it("clears expired disabledUntil and disabledReason", () => {
    const store = makeStore({
      "anthropic:default": {
        disabledUntil: Date.now() - 1_000,
        disabledReason: "billing",
        errorCount: 2,
        failureCounts: { billing: 2 },
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.disabledUntil).toBeUndefined();
    expect(stats?.disabledReason).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toBeUndefined();
  });

  it("handles independent expiry: cooldown expired but disabled still active", () => {
    const future = Date.now() + 3_600_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        disabledUntil: future,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { rate_limit: 3, billing: 2 },
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    // cooldownUntil cleared
    expect(stats?.cooldownUntil).toBeUndefined();
    // disabledUntil still active — not touched
    expect(stats?.disabledUntil).toBe(future);
    expect(stats?.disabledReason).toBe("billing");
    // errorCount NOT reset because profile still has an active unusable window
    expect(stats?.errorCount).toBe(5);
    expect(stats?.failureCounts).toEqual({ rate_limit: 3, billing: 2 });
  });

  it("handles independent expiry: disabled expired but cooldown still active", () => {
    const future = Date.now() + 300_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: future,
        disabledUntil: Date.now() - 1_000,
        disabledReason: "billing",
        errorCount: 3,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.cooldownUntil).toBe(future);
    expect(stats?.disabledUntil).toBeUndefined();
    expect(stats?.disabledReason).toBeUndefined();
    // errorCount NOT reset because cooldown is still active
    expect(stats?.errorCount).toBe(3);
  });

  it("resets errorCount only when both cooldown and disabled have expired", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 2_000,
        disabledUntil: Date.now() - 1_000,
        disabledReason: "billing",
        errorCount: 4,
        failureCounts: { rate_limit: 2, billing: 2 },
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expectProfileErrorStateCleared(stats);
  });

  it("processes multiple profiles independently", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        errorCount: 3,
      },
      "openai:default": {
        cooldownUntil: Date.now() + 300_000,
        errorCount: 2,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    // Anthropic: expired → cleared
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);

    // OpenAI: still active → untouched
    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(store.usageStats?.["openai:default"]?.errorCount).toBe(2);
  });

  it("accepts an explicit `now` timestamp for deterministic testing", () => {
    const fixedNow = 1_700_000_000_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: fixedNow - 1,
        errorCount: 2,
      },
    });

    expect(clearExpiredCooldowns(store, fixedNow)).toBe(true);
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
  });

  it("clears cooldownUntil that equals exactly `now`", () => {
    const fixedNow = 1_700_000_000_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: fixedNow,
        errorCount: 2,
      },
    });

    // ts >= cooldownUntil → should clear (cooldown "until" means the instant
    // at cooldownUntil the profile becomes available again).
    expect(clearExpiredCooldowns(store, fixedNow)).toBe(true);
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
  });

  it("ignores NaN and Infinity cooldown values", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: NaN,
        errorCount: 2,
      },
      "openai:default": {
        cooldownUntil: Infinity,
        errorCount: 3,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(false);
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(2);
    expect(store.usageStats?.["openai:default"]?.errorCount).toBe(3);
  });

  it("ignores zero and negative cooldown values", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: 0,
        errorCount: 1,
      },
      "openai:default": {
        cooldownUntil: -1,
        errorCount: 1,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearAuthProfileCooldown
// ---------------------------------------------------------------------------

describe("clearAuthProfileCooldown", () => {
  it("clears all error state fields including disabledUntil and failureCounts", async () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() + 60_000,
        disabledUntil: Date.now() + 3_600_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 3, rate_limit: 2 },
      },
    });

    await clearAuthProfileCooldown({ store, profileId: "anthropic:default" });

    const stats = store.usageStats?.["anthropic:default"];
    expectProfileErrorStateCleared(stats);
  });

  it("preserves lastUsed and lastFailureAt timestamps", async () => {
    const lastUsed = Date.now() - 10_000;
    const lastFailureAt = Date.now() - 5_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() + 60_000,
        errorCount: 3,
        lastUsed,
        lastFailureAt,
      },
    });

    await clearAuthProfileCooldown({ store, profileId: "anthropic:default" });

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.lastUsed).toBe(lastUsed);
    expect(stats?.lastFailureAt).toBe(lastFailureAt);
  });

  it("no-ops for unknown profile id", async () => {
    const store = makeStore(undefined);
    await clearAuthProfileCooldown({ store, profileId: "nonexistent" });
    expect(store.usageStats).toBeUndefined();
  });
});

describe("markAuthProfileFailure — active windows do not extend on retry", () => {
  // Regression for https://github.com/openclaw/openclaw/issues/23516
  // When all providers are at saturation backoff (60 min) and retries fire every 30 min,
  // each retry was resetting cooldownUntil to now+60m, preventing recovery.
  type WindowStats = ProfileUsageStats;

  async function markFailureAt(params: {
    store: ReturnType<typeof makeStore>;
    now: number;
    reason: "rate_limit" | "billing" | "auth_permanent";
  }): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: "anthropic:default",
        reason: params.reason,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  const activeWindowCases = [
    {
      label: "cooldownUntil",
      reason: "rate_limit" as const,
      buildUsageStats: (now: number): WindowStats => ({
        cooldownUntil: now + 50 * 60 * 1000,
        errorCount: 3,
        lastFailureAt: now - 10 * 60 * 1000,
      }),
      readUntil: (stats: WindowStats | undefined) => stats?.cooldownUntil,
    },
    {
      label: "disabledUntil",
      reason: "billing" as const,
      buildUsageStats: (now: number): WindowStats => ({
        disabledUntil: now + 20 * 60 * 60 * 1000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 5 },
        lastFailureAt: now - 60_000,
      }),
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
    {
      label: "disabledUntil(auth_permanent)",
      reason: "auth_permanent" as const,
      buildUsageStats: (now: number): WindowStats => ({
        disabledUntil: now + 20 * 60 * 60 * 1000,
        disabledReason: "auth_permanent",
        errorCount: 5,
        failureCounts: { auth_permanent: 5 },
        lastFailureAt: now - 60_000,
      }),
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
  ];

  for (const testCase of activeWindowCases) {
    it(`keeps active ${testCase.label} unchanged on retry`, async () => {
      const now = 1_000_000;
      const existingStats = testCase.buildUsageStats(now);
      const existingUntil = testCase.readUntil(existingStats);
      const store = makeStore({ "anthropic:default": existingStats });

      await markFailureAt({
        store,
        now,
        reason: testCase.reason,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(testCase.readUntil(stats)).toBe(existingUntil);
    });
  }

  const expiredWindowCases = [
    {
      label: "cooldownUntil",
      reason: "rate_limit" as const,
      buildUsageStats: (now: number): WindowStats => ({
        cooldownUntil: now - 60_000,
        errorCount: 3,
        lastFailureAt: now - 60_000,
      }),
      expectedUntil: (now: number) => now + 60 * 60 * 1000,
      readUntil: (stats: WindowStats | undefined) => stats?.cooldownUntil,
    },
    {
      label: "disabledUntil",
      reason: "billing" as const,
      buildUsageStats: (now: number): WindowStats => ({
        disabledUntil: now - 60_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 2 },
        lastFailureAt: now - 60_000,
      }),
      expectedUntil: (now: number) => now + 20 * 60 * 60 * 1000,
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
    {
      label: "disabledUntil(auth_permanent)",
      reason: "auth_permanent" as const,
      buildUsageStats: (now: number): WindowStats => ({
        disabledUntil: now - 60_000,
        disabledReason: "auth_permanent",
        errorCount: 5,
        failureCounts: { auth_permanent: 2 },
        lastFailureAt: now - 60_000,
      }),
      expectedUntil: (now: number) => now + 20 * 60 * 60 * 1000,
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
  ];

  for (const testCase of expiredWindowCases) {
    it(`recomputes ${testCase.label} after the previous window expires`, async () => {
      const now = 1_000_000;
      const store = makeStore({
        "anthropic:default": testCase.buildUsageStats(now),
      });

      await markFailureAt({
        store,
        now,
        reason: testCase.reason,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(testCase.readUntil(stats)).toBe(testCase.expectedUntil(now));
    });
  }
});
