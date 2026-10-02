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

describe("resolveProfileUnusableUntil", () => {
  it("returns null when all values are missing or invalid", () => {
    expect(resolveProfileUnusableUntil({})).toBeNull();
    expect(resolveProfileUnusableUntil({ cooldownUntil: 0, disabledUntil: Number.NaN })).toBeNull();
    expect(resolveProfileUnusableUntil({ blockedUntil: MAX_DATE_TIMESTAMP_MS + 1 })).toBeNull();
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
      "returns false when cooldownUntil has passed",
      "anthropic:default",
      { cooldownUntil: now - 1_000 },
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
  it("excludes sibling models from model_not_found cooldowns — #116464", () => {
    const now = 1_700_000_000_000;
    const store = makeStore({
      "github-copilot:github": {
        cooldownUntil: now + 60_000,
        cooldownReason: "model_not_found",
        cooldownModel: "claude-sonnet-4.6",
      },
    });
    const expiry = (forModel: string) =>
      getSoonestCooldownExpiry(store, ["github-copilot:github"], { now, forModel });
    expect(expiry("claude-sonnet-4.6")).toBe(now + 60_000);
    expect(expiry("gpt-4.1")).toBeNull();
  });
});

describe("resolveProfilesUnavailableReason", () => {
  const now = 1_700_000_000_000;
  const cases: Array<{
    name: string;
    usageStats: AuthProfileStore["usageStats"];
    expected: ReturnType<typeof resolveProfilesUnavailableReason>;
  }> = [
    {
      name: "prefers an active disabled reason",
      usageStats: { primary: { disabledUntil: now + 60_000, disabledReason: "billing" } },
      expected: "billing",
    },
    {
      name: "prefers an explicit cooldown reason over stale failure counts",
      usageStats: {
        primary: {
          cooldownUntil: now + 60_000,
          cooldownReason: "auth",
          failureCounts: { rate_limit: 99 },
        },
      },
      expected: "auth",
    },
    {
      name: "returns session_expired when every cooled profile has an expired session",
      usageStats: {
        primary: { cooldownUntil: now + 60_000, failureCounts: { session_expired: 1 } },
        backup: { cooldownUntil: now + 60_000, failureCounts: { session_expired: 1 } },
      },
      expected: "session_expired",
    },
    {
      name: "uses the most frequent failure reason",
      usageStats: {
        primary: { cooldownUntil: now + 60_000, failureCounts: { overloaded: 2, rate_limit: 1 } },
      },
      expected: "overloaded",
    },
    {
      name: "falls back to unknown when an active cooldown has no reason history",
      usageStats: { primary: { cooldownUntil: now + 60_000 } },
      expected: "unknown",
    },
    {
      name: "ignores expired windows",
      usageStats: {
        primary: { cooldownUntil: now - 1_000, failureCounts: { auth: 5 } },
        backup: { disabledUntil: now - 500, disabledReason: "billing" },
      },
      expected: null,
    },
    {
      name: "breaks ties by reason priority",
      usageStats: {
        primary: { cooldownUntil: now + 60_000, failureCounts: { timeout: 2, auth: 2 } },
      },
      expected: "auth",
    },
  ];
  it.each(cases)("$name", ({ usageStats, expected }) => {
    expect(
      resolveProfilesUnavailableReason({
        store: makeStore(usageStats),
        profileIds: Object.keys(usageStats ?? {}),
        now,
      }),
    ).toBe(expected);
  });
});

describe("clearExpiredCooldowns", () => {
  const now = 1_700_000_000_000;
  const unchangedCases: Array<{
    name: string;
    usageStats: AuthProfileStore["usageStats"];
  }> = [
    { name: "missing usage stats", usageStats: undefined },
    { name: "no cooldowns", usageStats: { primary: { lastUsed: now } } },
    {
      name: "non-finite cooldowns",
      usageStats: {
        primary: { cooldownUntil: Number.NaN, errorCount: 2 },
        backup: { cooldownUntil: Infinity, errorCount: 3 },
      },
    },
    {
      name: "non-positive cooldowns",
      usageStats: {
        primary: { cooldownUntil: 0, errorCount: 1 },
        backup: { cooldownUntil: -1, errorCount: 1 },
      },
    },
  ];
  it.each(unchangedCases)("leaves $name unchanged", ({ usageStats }) => {
    const store = makeStore(structuredClone(usageStats));
    expect(clearExpiredCooldowns(store, now)).toBe(false);
    expect(store.usageStats).toEqual(usageStats);
  });

  const expiryCases: Array<{
    name: string;
    before: ProfileUsageStats;
    after: ProfileUsageStats;
  }> = [
    {
      name: "clears a cooldown at its expiry boundary, including its classification",
      before: {
        cooldownUntil: now,
        cooldownClassification: "wham_token_expired",
        errorCount: 4,
        failureCounts: { timeout: 1 },
        lastFailureAt: now - 120_000,
      },
      after: {
        cooldownUntil: undefined,
        cooldownClassification: undefined,
        cooldownReason: undefined,
        cooldownModel: undefined,
        errorCount: 0,
        failureCounts: undefined,
        lastFailureAt: now - 120_000,
      },
    },
    {
      name: "clears an expired cooldown while preserving an active disable",
      before: {
        cooldownUntil: now - 1_000,
        disabledUntil: now + 3_600_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { rate_limit: 3, billing: 2 },
      },
      after: {
        cooldownUntil: undefined,
        cooldownReason: undefined,
        cooldownModel: undefined,
        disabledUntil: now + 3_600_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { rate_limit: 3, billing: 2 },
      },
    },
    {
      name: "clears an expired disable while preserving an active cooldown",
      before: {
        cooldownUntil: now + 300_000,
        disabledUntil: now - 1_000,
        disabledReason: "billing",
        errorCount: 3,
      },
      after: {
        cooldownUntil: now + 300_000,
        disabledUntil: undefined,
        disabledReason: undefined,
        errorCount: 3,
      },
    },
    {
      name: "resets aggregate count but preserves rate-limit history after all windows expire",
      before: {
        cooldownUntil: now - 2_000,
        disabledUntil: now - 1_000,
        disabledReason: "billing",
        errorCount: 4,
        failureCounts: { rate_limit: 2, billing: 2 },
      },
      after: {
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
  ];
  it.each(expiryCases)("$name", ({ before, after }) => {
    const store = makeStore({ primary: structuredClone(before) });
    expect(clearExpiredCooldowns(store, now)).toBe(true);
    expect(store.usageStats).toEqual({ primary: after });
  });

  it("clears an expired provider block but preserves retry backoff until success", () => {
    const lastFailureAt = now - 120_000;
    const store = makeStore({
      "openai:default": {
        blockedUntil: now - 1_000,
        blockedReason: "subscription_limit",
        blockedSource: "codex_rate_limits",
        errorCount: 4,
        failureCounts: { rate_limit: 4, timeout: 2 },
        lastFailureAt,
      },
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(clearExpiredCooldowns(store)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
    const stats = store.usageStats?.["openai:default"];
    expect(stats?.blockedUntil).toBeUndefined();
    expect(stats?.blockedReason).toBeUndefined();
    expect(stats?.blockedSource).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toEqual({ rate_limit: 4 });
    expect(stats?.lastFailureAt).toBe(lastFailureAt);
  });
});
