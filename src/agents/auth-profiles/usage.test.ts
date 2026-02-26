import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./types.js";
import {
  calculateAuthProfileCooldownMs,
  clearExpiredCooldowns,
  isProfileInCooldown,
  isProfileInCooldownForModel,
  resolveProfileUnusableUntil,
} from "./usage.js";

function makeStore(usageStats: AuthProfileStore["usageStats"]): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test-2" },
    },
    usageStats,
  };
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
    expect(stats?.cooldownUntil).toBeUndefined();
    expect(stats?.disabledUntil).toBeUndefined();
    expect(stats?.disabledReason).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toBeUndefined();
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

  it("clears expired model-level cooldowns", () => {
    const fixedNow = 1_700_000_000_000;
    const store = makeStore({
      "anthropic:default": {
        errorCount: 2,
        modelCooldowns: {
          "claude-opus-4-6": {
            cooldownUntil: fixedNow - 1_000,
            errorCount: 1,
          },
          "claude-sonnet-4-6": {
            cooldownUntil: fixedNow + 60_000,
            errorCount: 1,
          },
        },
      },
    });

    expect(clearExpiredCooldowns(store, fixedNow)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    // Expired opus cooldown removed
    expect(stats?.modelCooldowns?.["claude-opus-4-6"]).toBeUndefined();
    // Active sonnet cooldown preserved
    expect(stats?.modelCooldowns?.["claude-sonnet-4-6"]?.cooldownUntil).toBe(fixedNow + 60_000);
  });

  it("removes modelCooldowns map when all entries expire", () => {
    const fixedNow = 1_700_000_000_000;
    const store = makeStore({
      "anthropic:default": {
        errorCount: 1,
        modelCooldowns: {
          "claude-opus-4-6": {
            cooldownUntil: fixedNow - 1_000,
            errorCount: 1,
          },
        },
      },
    });

    expect(clearExpiredCooldowns(store, fixedNow)).toBe(true);
    expect(store.usageStats?.["anthropic:default"]?.modelCooldowns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// calculateAuthProfileCooldownMs — 2^n backoff
// ---------------------------------------------------------------------------

describe("calculateAuthProfileCooldownMs", () => {
  it("returns ~60s for first error (non-timeout)", () => {
    const ms = calculateAuthProfileCooldownMs(1, "rate_limit");
    // Base is 60s, jitter adds 10-20%, so range is 66_000 – 72_000
    expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(ms).toBeLessThanOrEqual(72_000);
  });

  it("follows 2^n progression for rate_limit (2min, 4min, 8min, 15min max)", () => {
    // errorCount=2 → 60s * 2^1 = 120s base + jitter
    const ms2 = calculateAuthProfileCooldownMs(2, "rate_limit");
    expect(ms2).toBeGreaterThanOrEqual(120_000);
    expect(ms2).toBeLessThanOrEqual(144_000);

    // errorCount=3 → 60s * 2^2 = 240s base + jitter
    const ms3 = calculateAuthProfileCooldownMs(3, "rate_limit");
    expect(ms3).toBeGreaterThanOrEqual(240_000);
    expect(ms3).toBeLessThanOrEqual(288_000);

    // errorCount=4 → 60s * 2^3 = 480s base + jitter
    const ms4 = calculateAuthProfileCooldownMs(4, "rate_limit");
    expect(ms4).toBeGreaterThanOrEqual(480_000);
    expect(ms4).toBeLessThanOrEqual(576_000);

    // errorCount=5 → 60s * 2^4 = 960s = 16min → capped to 15min base + jitter
    const ms5 = calculateAuthProfileCooldownMs(5, "rate_limit");
    expect(ms5).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(ms5).toBeLessThanOrEqual(15 * 60 * 1000 * 1.2);
  });

  it("never exceeds 15 minutes for non-timeout", () => {
    const ms = calculateAuthProfileCooldownMs(100, "rate_limit");
    expect(ms).toBeLessThanOrEqual(15 * 60 * 1000 * 1.2); // 15min + jitter
  });

  it("returns shorter cooldowns for timeout", () => {
    // errorCount=1 → 30s
    expect(calculateAuthProfileCooldownMs(1, "timeout")).toBe(30_000);
    // errorCount=2 → 60s
    expect(calculateAuthProfileCooldownMs(2, "timeout")).toBe(60_000);
    // errorCount=3 → 120s
    expect(calculateAuthProfileCooldownMs(3, "timeout")).toBe(120_000);
    // errorCount=4 → 240s
    expect(calculateAuthProfileCooldownMs(4, "timeout")).toBe(240_000);
    // errorCount=5 → 480s → capped at 300s (5min)
    expect(calculateAuthProfileCooldownMs(5, "timeout")).toBe(5 * 60 * 1000);
  });

  it("never exceeds 5 minutes for timeout", () => {
    expect(calculateAuthProfileCooldownMs(100, "timeout")).toBe(5 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// isProfileInCooldownForModel
// ---------------------------------------------------------------------------

describe("isProfileInCooldownForModel", () => {
  it("returns false when profile has no usage stats", () => {
    const store = makeStore(undefined);
    expect(isProfileInCooldownForModel(store, "anthropic:default", "claude-opus-4-6")).toBe(false);
  });

  it("returns true when profile has a global disabledUntil (billing)", () => {
    const store = makeStore({
      "anthropic:default": { disabledUntil: Date.now() + 60_000, disabledReason: "billing" },
    });
    expect(isProfileInCooldownForModel(store, "anthropic:default", "claude-opus-4-6")).toBe(true);
    expect(isProfileInCooldownForModel(store, "anthropic:default", "claude-sonnet-4-6")).toBe(true);
  });

  it("returns true for a specific model in cooldown", () => {
    const store = makeStore({
      "anthropic:default": {
        modelCooldowns: {
          "claude-opus-4-6": { cooldownUntil: Date.now() + 60_000, errorCount: 1 },
        },
      },
    });
    expect(isProfileInCooldownForModel(store, "anthropic:default", "claude-opus-4-6")).toBe(true);
  });

  it("returns false for a different model when only one model is in cooldown", () => {
    const store = makeStore({
      "anthropic:default": {
        modelCooldowns: {
          "claude-opus-4-6": { cooldownUntil: Date.now() + 60_000, errorCount: 1 },
        },
      },
    });
    // sonnet is NOT in cooldown — only opus is
    expect(isProfileInCooldownForModel(store, "anthropic:default", "claude-sonnet-4-6")).toBe(
      false,
    );
  });

  it("falls back to global cooldown check when no model is specified", () => {
    const store = makeStore({
      "anthropic:default": { cooldownUntil: Date.now() + 60_000 },
    });
    expect(isProfileInCooldownForModel(store, "anthropic:default")).toBe(true);
    expect(isProfileInCooldownForModel(store, "anthropic:default", undefined)).toBe(true);
  });

  it("returns false for expired model cooldown", () => {
    const store = makeStore({
      "anthropic:default": {
        modelCooldowns: {
          "claude-opus-4-6": { cooldownUntil: Date.now() - 1_000, errorCount: 1 },
        },
      },
    });
    expect(isProfileInCooldownForModel(store, "anthropic:default", "claude-opus-4-6")).toBe(false);
  });
});
