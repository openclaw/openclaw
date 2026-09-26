import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createAuthProfileUsageStore as makeStore } from "./credential-fixtures.test-support.js";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import {
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntil,
  resolveProfileUnusableUntilForDisplay,
} from "./usage-state.js";

function expectProfileErrorStateCleared(
  stats: NonNullable<AuthProfileStore["usageStats"]>[string] | undefined,
) {
  expect(stats?.blockedUntil).toBeUndefined();
  expect(stats?.blockedReason).toBeUndefined();
  expect(stats?.blockedScope).toBeUndefined();
  expect(stats?.cooldownUntil).toBeUndefined();
  expect(stats?.cooldownClassification).toBeUndefined();
  expect(stats?.disabledUntil).toBeUndefined();
  expect(stats?.disabledReason).toBeUndefined();
  expect(stats?.errorCount).toBe(0);
  expect(stats?.failureCounts).toBeUndefined();
}

describe("resolveProfileUnusableUntil", () => {
  it("returns null when all values are missing or invalid", () => {
    expect(resolveProfileUnusableUntil({})).toBeNull();
    expect(resolveProfileUnusableUntil({ cooldownUntil: 0, disabledUntil: Number.NaN })).toBeNull();
    expect(resolveProfileUnusableUntil({ blockedUntil: MAX_DATE_TIMESTAMP_MS + 1 })).toBeNull();
  });

  it("returns the latest active timestamp", () => {
    expect(
      resolveProfileUnusableUntil({ blockedUntil: 300, cooldownUntil: 100, disabledUntil: 200 }),
    ).toBe(300);
    expect(resolveProfileUnusableUntil({ cooldownUntil: 300 })).toBe(300);
  });

  it("keeps legacy blockedModel rows profile-wide", () => {
    expect(
      resolveProfileUnusableUntil({ blockedUntil: 300, blockedModel: "model-a" }, "model-b"),
    ).toBe(300);
  });

  it("applies explicitly model-scoped blocks only to that model", () => {
    const stats = { blockedUntil: 300, blockedModel: "model-a", blockedScope: "model" as const };
    expect(resolveProfileUnusableUntil(stats, "model-a")).toBe(300);
    expect(resolveProfileUnusableUntil(stats, "model-b")).toBeNull();
  });
});

describe("account-wide auth profile cooldowns", () => {
  it("ignores windows scoped to one model", () => {
    expect(
      resolveProfileUnusableUntil(
        {
          blockedUntil: 300,
          blockedModel: "model-a",
          blockedScope: "model",
          cooldownUntil: 400,
          cooldownReason: "rate_limit",
          cooldownModel: "model-a",
        },
        null,
      ),
    ).toBeNull();
  });

  it("keeps profile-wide and disabled windows", () => {
    expect(
      resolveProfileUnusableUntil(
        {
          blockedUntil: 300,
          cooldownUntil: 400,
          cooldownReason: "rate_limit",
          disabledUntil: 500,
        },
        null,
      ),
    ).toBe(500);
  });

  it("distinguishes model-scoped and profile-wide cooldowns", () => {
    const now = Date.now();
    const store = makeStore({
      "openai:api-key": {
        cooldownUntil: now + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "gpt-5.5",
      },
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        cooldownReason: "rate_limit",
      },
    });

    expect(isProfileInCooldown(store, "openai:api-key", now, null)).toBe(false);
    expect(isProfileInCooldown(store, "anthropic:default", now, null)).toBe(true);
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
  const now = 1_700_000_000_000;
  type CooldownCase = [
    name: string,
    profileId: string,
    stats: ProfileUsageStats | undefined,
    checks: Array<[forModel: string | undefined, expected: boolean]>,
  ];
  const activeCooldown = (
    reason: ProfileUsageStats["cooldownReason"],
    model: string | undefined,
    extra: Partial<ProfileUsageStats> = {},
  ): ProfileUsageStats => ({
    cooldownUntil: now + 60_000,
    cooldownReason: reason,
    cooldownModel: model,
    ...extra,
  });
  const cases: CooldownCase[] = [
    [
      "returns false when profile has no usage stats",
      "anthropic:default",
      undefined,
      [[undefined, false]],
    ],
    [
      "returns true when cooldownUntil is in the future",
      "anthropic:default",
      { cooldownUntil: now + 60_000 },
      [[undefined, true]],
    ],
    [
      "returns true when blockedUntil is in the future",
      "openai:default",
      { blockedUntil: now + 60_000, blockedReason: "subscription_limit" },
      [[undefined, true]],
    ],
    [
      "returns false when cooldownUntil has passed",
      "anthropic:default",
      { cooldownUntil: now - 1_000 },
      [[undefined, false]],
    ],
    [
      "returns false when cooldownUntil is out of range",
      "anthropic:default",
      { cooldownUntil: MAX_DATE_TIMESTAMP_MS + 1 },
      [[undefined, false]],
    ],
    [
      "returns true when disabledUntil is in the future (even if cooldownUntil expired)",
      "anthropic:default",
      { cooldownUntil: now - 1_000, disabledUntil: now + 60_000 },
      [[undefined, true]],
    ],
    [
      "returns false for OpenRouter even when cooldown fields exist",
      "openrouter:default",
      activeCooldown(undefined, undefined, {
        disabledUntil: now + 60_000,
        disabledReason: "billing",
      }),
      [[undefined, false]],
    ],
    [
      "returns false for Kilocode even when cooldown fields exist",
      "kilocode:default",
      activeCooldown(undefined, undefined, {
        disabledUntil: now + 60_000,
        disabledReason: "billing",
      }),
      [[undefined, false]],
    ],
    [
      "returns false for a different model when cooldown is model-scoped (rate_limit)",
      "github-copilot:github",
      activeCooldown("rate_limit", "claude-sonnet-4.6"),
      [
        ["gpt-4.1", false],
        ["claude-sonnet-4.6", true],
        [undefined, true],
      ],
    ],
    [
      "returns true for all models when cooldownModel is undefined (profile-wide)",
      "github-copilot:github",
      activeCooldown("rate_limit", undefined),
      [
        ["claude-sonnet-4.6", true],
        ["gpt-4.1", true],
      ],
    ],
    [
      "returns false for a different model when cooldown is model-scoped (timeout) — #87462",
      "google:default",
      activeCooldown("timeout", "gemini-3-flash-preview"),
      [
        ["gemini-3.1-flash-lite", false],
        ["gemini-2.5-flash", false],
        ["gemini-3-flash-preview", true],
        [undefined, true],
      ],
    ],
    [
      "returns true for all models when timeout cooldownModel is undefined (legacy widened scope)",
      "google:default",
      activeCooldown("timeout", undefined),
      [
        ["gemini-3-flash-preview", true],
        ["gemini-3.1-flash-lite", true],
      ],
    ],
    [
      "returns false for a different model when cooldown is model-scoped (model_not_found) — #116464",
      "github-copilot:github",
      activeCooldown("model_not_found", "claude-sonnet-4.6"),
      [
        ["gpt-4.1", false],
        ["claude-sonnet-4.6", true],
        [undefined, true],
      ],
    ],
    [
      "blocks all models when a model_not_found cooldown has no cooldownModel (profile-wide) — #116464",
      "github-copilot:github",
      activeCooldown("model_not_found", undefined),
      [
        ["gpt-4.1", true],
        ["claude-sonnet-4.6", true],
      ],
    ],
    [
      "does not bypass model-scoped cooldown when disabledUntil is active",
      "github-copilot:github",
      activeCooldown("rate_limit", "claude-sonnet-4.6", {
        disabledUntil: now + 120_000,
        disabledReason: "billing",
      }),
      [["gpt-4.1", true]],
    ],
    [
      "bypasses model-scoped blocks and cooldowns for sibling models",
      "google:default",
      activeCooldown("timeout", "gemini-3-flash-preview", {
        blockedUntil: now + 120_000,
        blockedReason: "subscription_limit",
        blockedModel: "gemini-3-flash-preview",
        blockedScope: "model",
      }),
      [
        ["gemini-3-flash-preview", true],
        ["gemini-3.1-flash-lite", false],
      ],
    ],
    [
      "keeps legacy blockedModel rows active for sibling models",
      "google:default",
      { blockedUntil: now + 120_000, blockedModel: "gemini-3-flash-preview" },
      [["gemini-3.1-flash-lite", true]],
    ],
  ];

  it.each(cases)("%s", (name, profileId, stats, checks) => {
    const store = makeStore(stats === undefined ? undefined : { [profileId]: stats });
    for (const [forModel, expected] of checks) {
      expect(
        isProfileInCooldown(store, profileId, now, forModel),
        `${name}: ${forModel ?? "profile-wide"}`,
      ).toBe(expected);
    }
  });
});

describe("getSoonestCooldownExpiry", () => {
  const now = 1_700_000_000_000;
  it.each([
    {
      name: "treats a model_not_found cooldown for the requested model as model-scoped — #116464",
      cooldownModel: "claude-sonnet-4.6",
      checks: [
        { forModel: "claude-sonnet-4.6", expected: now + 60_000 },
        { forModel: "gpt-4.1", expected: null },
      ],
    },
    {
      name: "keeps profile-wide cooldowns visible to all models",
      cooldownModel: undefined,
      checks: [{ forModel: "gpt-4.1", expected: now + 60_000 }],
    },
  ])("$name", ({ name, cooldownModel, checks }) => {
    const store = makeStore({
      "github-copilot:github": {
        cooldownUntil: now + 60_000,
        cooldownReason: "model_not_found",
        cooldownModel,
      },
    });
    for (const check of checks) {
      expect(
        getSoonestCooldownExpiry(store, ["github-copilot:github"], {
          now,
          forModel: check.forModel,
        }),
        `${name}: ${check.forModel}`,
      ).toBe(check.expected);
    }
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

  it("prefers an explicit cooldown reason over stale failure counts", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        cooldownReason: "auth",
        failureCounts: { rate_limit: 99 },
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

  it("returns session_expired when every cooled profile has an expired session", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        failureCounts: { session_expired: 1 },
      },
      "anthropic:backup": {
        cooldownUntil: now + 60_000,
        failureCounts: { session_expired: 1 },
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default", "anthropic:backup"],
        now,
      }),
    ).toBe("session_expired");
  });

  it("returns overloaded for active overloaded cooldown windows", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        failureCounts: { overloaded: 2, rate_limit: 1 },
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("overloaded");
  });

  it("falls back to unknown when active cooldown has no reason history", () => {
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
    ).toBe("unknown");
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
  const now = 1_700_000_000_000;
  type ClearExpiredCase = {
    name: string;
    usageStats: AuthProfileStore["usageStats"];
    expectedMutated: boolean;
    expectedUsageStats: AuthProfileStore["usageStats"];
    expectCleared?: boolean;
    explicitNow?: boolean;
  };
  const cases: ClearExpiredCase[] = [
    {
      name: "returns false on empty usageStats",
      usageStats: undefined,
      expectedMutated: false,
      expectedUsageStats: undefined,
    },
    {
      name: "returns false when no profiles have cooldowns",
      usageStats: { "anthropic:default": { lastUsed: now } },
      expectedMutated: false,
      expectedUsageStats: { "anthropic:default": { lastUsed: now } },
    },
    {
      name: "returns false when cooldown is still active",
      usageStats: { "anthropic:default": { cooldownUntil: now + 300_000, errorCount: 3 } },
      expectedMutated: false,
      expectedUsageStats: {
        "anthropic:default": { cooldownUntil: now + 300_000, errorCount: 3 },
      },
    },
    {
      name: "clears expired cooldownUntil and resets errorCount",
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now - 1_000,
          cooldownClassification: "wham_token_expired",
          errorCount: 4,
          failureCounts: { timeout: 1 },
          lastFailureAt: now - 120_000,
        },
      },
      expectedMutated: true,
      expectCleared: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownClassification: undefined,
          cooldownReason: undefined,
          cooldownModel: undefined,
          errorCount: 0,
          failureCounts: undefined,
          lastFailureAt: now - 120_000,
        },
      },
    },
    {
      name: "clears expired disabledUntil and disabledReason",
      usageStats: {
        "anthropic:default": {
          disabledUntil: now - 1_000,
          disabledReason: "billing",
          errorCount: 2,
          failureCounts: { billing: 2 },
        },
      },
      expectedMutated: true,
      expectCleared: true,
      expectedUsageStats: {
        "anthropic:default": {
          disabledUntil: undefined,
          disabledReason: undefined,
          errorCount: 0,
          failureCounts: undefined,
        },
      },
    },
    {
      name: "handles independent expiry: cooldown expired but disabled still active",
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now - 1_000,
          disabledUntil: now + 3_600_000,
          disabledReason: "billing",
          errorCount: 5,
          failureCounts: { rate_limit: 3, billing: 2 },
        },
      },
      expectedMutated: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownModel: undefined,
          disabledUntil: now + 3_600_000,
          disabledReason: "billing",
          errorCount: 5,
          failureCounts: { rate_limit: 3, billing: 2 },
        },
      },
    },
    {
      name: "handles independent expiry: disabled expired but cooldown still active",
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now + 300_000,
          disabledUntil: now - 1_000,
          disabledReason: "billing",
          errorCount: 3,
        },
      },
      expectedMutated: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: now + 300_000,
          disabledUntil: undefined,
          disabledReason: undefined,
          errorCount: 3,
        },
      },
    },
    {
      name: "resets aggregate count but preserves rate-limit history after all windows expire",
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now - 2_000,
          disabledUntil: now - 1_000,
          disabledReason: "billing",
          errorCount: 4,
          failureCounts: { rate_limit: 2, billing: 2 },
        },
      },
      expectedMutated: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownClassification: undefined,
          cooldownModel: undefined,
          disabledUntil: undefined,
          disabledReason: undefined,
          errorCount: 0,
          failureCounts: { rate_limit: 2 },
        },
      },
    },
    {
      name: "clears cooldownUntil that equals exactly `now`",
      usageStats: { "anthropic:default": { cooldownUntil: now, errorCount: 2 } },
      expectedMutated: true,
      expectCleared: true,
      explicitNow: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownModel: undefined,
          errorCount: 0,
          failureCounts: undefined,
        },
      },
    },
    {
      name: "ignores NaN and Infinity cooldown values",
      usageStats: {
        "anthropic:default": { cooldownUntil: Number.NaN, errorCount: 2 },
        "openai:default": { cooldownUntil: Infinity, errorCount: 3 },
      },
      expectedMutated: false,
      expectedUsageStats: {
        "anthropic:default": { cooldownUntil: Number.NaN, errorCount: 2 },
        "openai:default": { cooldownUntil: Infinity, errorCount: 3 },
      },
    },
    {
      name: "ignores zero and negative cooldown values",
      usageStats: {
        "anthropic:default": { cooldownUntil: 0, errorCount: 1 },
        "openai:default": { cooldownUntil: -1, errorCount: 1 },
      },
      expectedMutated: false,
      expectedUsageStats: {
        "anthropic:default": { cooldownUntil: 0, errorCount: 1 },
        "openai:default": { cooldownUntil: -1, errorCount: 1 },
      },
    },
  ];

  it.each(cases)("$name", (testCase) => {
    const store = makeStore(structuredClone(testCase.usageStats));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(clearExpiredCooldowns(store, testCase.explicitNow ? now : undefined)).toBe(
        testCase.expectedMutated,
      );
    } finally {
      nowSpy.mockRestore();
    }
    expect(store.usageStats).toEqual(testCase.expectedUsageStats);
    if (testCase.expectCleared) {
      expectProfileErrorStateCleared(store.usageStats?.["anthropic:default"]);
    }
  });

  it("clears an expired provider block but preserves retry backoff until success", () => {
    const lastFailureAt = Date.now() - 120_000;
    const store = makeStore({
      "openai:default": {
        blockedUntil: Date.now() - 1_000,
        blockedReason: "subscription_limit",
        blockedSource: "codex_rate_limits",
        errorCount: 4,
        failureCounts: { rate_limit: 4, timeout: 2 },
        lastFailureAt,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["openai:default"];
    expect(stats?.blockedUntil).toBeUndefined();
    expect(stats?.blockedReason).toBeUndefined();
    expect(stats?.blockedSource).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toEqual({ rate_limit: 4 });
    expect(stats?.lastFailureAt).toBe(lastFailureAt);
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
});
