import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./types.js";
import {
  clearExpiredCooldowns,
  isProfileInCooldown,
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
});
