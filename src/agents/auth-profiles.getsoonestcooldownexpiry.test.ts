import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import { getSoonestCooldownExpiry } from "./auth-profiles.js";

function makeStore(usageStats?: AuthProfileStore["usageStats"]): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
    usageStats,
  };
}

describe("getSoonestCooldownExpiry", () => {
  it("returns null when no cooldown timestamps exist", () => {
    const store = makeStore();
    expect(getSoonestCooldownExpiry(store, ["openai:p1"])).toBeNull();
  });

  it("returns earliest unusable time across profiles", () => {
    const store = makeStore({
      "openai:p1": {
        cooldownUntil: 1_700_000_002_000,
        disabledUntil: 1_700_000_004_000,
      },
      "openai:p2": {
        cooldownUntil: 1_700_000_003_000,
      },
      "openai:p3": {
        disabledUntil: 1_700_000_001_000,
      },
    });

    expect(getSoonestCooldownExpiry(store, ["openai:p1", "openai:p2", "openai:p3"])).toBe(
      1_700_000_001_000,
    );
  });

  it("ignores unknown profiles and invalid cooldown values", () => {
    const store = makeStore({
      "openai:p1": {
        cooldownUntil: -1,
      },
      "openai:p2": {
        cooldownUntil: Infinity,
      },
      "openai:p3": {
        disabledUntil: NaN,
      },
      "openai:p4": {
        cooldownUntil: 1_700_000_005_000,
      },
    });

    expect(
      getSoonestCooldownExpiry(store, [
        "missing",
        "openai:p1",
        "openai:p2",
        "openai:p3",
        "openai:p4",
      ]),
    ).toBe(1_700_000_005_000);
  });

  it("returns past timestamps when cooldown already expired", () => {
    const store = makeStore({
      "openai:p1": {
        cooldownUntil: 1_700_000_000_000,
      },
      "openai:p2": {
        disabledUntil: 1_700_000_010_000,
      },
    });

    expect(getSoonestCooldownExpiry(store, ["openai:p1", "openai:p2"])).toBe(1_700_000_000_000);
  });
});
