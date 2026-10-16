import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createAuthProfileUsageStore as makeStore } from "./credential-fixtures.test-support.js";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import {
  clearExpiredCooldowns,
  resetAuthProfileFailureState,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntil,
  resolveProfileUnusableUntilForDisplay,
  readAuthProfileUsageStats,
  readInlineProviderApiKeyUsage,
} from "./usage-state.js";

it("preserves a sibling model cooldown until that model succeeds", () => {
  const existing: ProfileUsageStats = {
    cooldownReason: "rate_limit",
    cooldownModel: "primary",
    cooldownUntil: 31_000,
    errorCount: 1,
    failureCounts: { rate_limit: 1 },
    lastFailureAt: 1_000,
  };
  const siblingSuccess = resetAuthProfileFailureState(existing, { lastUsed: 2_000 }, "fallback");
  expect(siblingSuccess).toMatchObject({ ...existing, lastUsed: 2_000 });
  const primarySuccess = resetAuthProfileFailureState(
    siblingSuccess,
    { lastUsed: 32_000 },
    "primary",
  );
  expect(primarySuccess.cooldownUntil).toBeUndefined();
  expect(primarySuccess.failureCounts).toBeUndefined();
  expect(primarySuccess.lastUsed).toBe(32_000);
});

const now = 1_700_000_000_000;
const until = now + 60_000;
const anthropic = "anthropic:default";
const copilot = "github-copilot:github";
const sonnet = "claude-sonnet-4.6";
const gemini = "gemini-3-flash-preview";
const cooldown = (
  reason?: ProfileUsageStats["cooldownReason"],
  model?: string,
  extra: Partial<ProfileUsageStats> = {},
): ProfileUsageStats => ({
  cooldownUntil: until,
  cooldownReason: reason,
  cooldownModel: model,
  ...extra,
});

describe("auth profile usage state", () => {
  beforeEach(() =>
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "openrouter", providers: ["openrouter"], managesOwnAvailability: true }],
      }),
      { config: {} },
    ),
  );
  afterEach(() => setCurrentPluginMetadataSnapshot(undefined));
  it("resolves valid account-wide timestamps and ignores model-scoped windows", () => {
    const cases: Array<[ProfileUsageStats, string | null | undefined, number | null]> = [
      [{}, undefined, null],
      [{ cooldownUntil: 0, disabledUntil: Number.NaN }, undefined, null],
      [{ blockedUntil: MAX_DATE_TIMESTAMP_MS + 1 }, undefined, null],
      [
        {
          blockedUntil: 300,
          blockedModel: "model-a",
          blockedScope: "model",
          cooldownUntil: 400,
          cooldownReason: "rate_limit",
          cooldownModel: "model-a",
        },
        null,
        null,
      ],
      [
        { blockedUntil: 300, cooldownUntil: 400, cooldownReason: "rate_limit", disabledUntil: 500 },
        null,
        500,
      ],
    ];
    for (const [stats, model, expected] of cases) {
      expect(resolveProfileUnusableUntil(stats, model)).toBe(expected);
    }
  });

  it.each(["rate_limit", "overloaded"] as const)(
    "ignores only the managed %s cooldown window",
    (reason) => {
      const profileId = "openrouter:default";
      const raw = { ...cooldown(reason), cooldownUntil: now + 120_000 };
      const store = makeStore({ [profileId]: raw });
      expect(isProfileInCooldown(store, profileId, now)).toBe(false);
      expect(getSoonestCooldownExpiry(store, [profileId], { now })).toBeNull();
      expect(resolveProfileUnusableUntilForDisplay(store, profileId)).toBeNull();
      expect(resolveProfilesUnavailableReason({ store, profileIds: [profileId], now })).toBeNull();
      expect(readAuthProfileUsageStats(store, profileId)?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.[profileId]).toEqual(raw);

      for (const permanent of [
        { disabledUntil: until, disabledReason: "billing" },
        { disabledUntil: until, disabledReason: "auth_permanent" },
        { blockedUntil: until, blockedReason: "subscription_limit", blockedSource: "wham" },
      ] satisfies Partial<ProfileUsageStats>[]) {
        store.usageStats![profileId] = { ...raw, ...permanent };
        expect(isProfileInCooldown(store, profileId, now)).toBe(true);
        expect(getSoonestCooldownExpiry(store, [profileId], { now })).toBe(until);
        expect(resolveProfileUnusableUntilForDisplay(store, profileId)).toBe(until);
        expect(resolveProfilesUnavailableReason({ store, profileIds: [profileId], now })).toBe(
          "disabledReason" in permanent ? permanent.disabledReason : "rate_limit",
        );
      }
    },
  );

  it.each(["auth", undefined] as const)(
    "keeps managed %s failures and inline credential health",
    (reason) => {
      const profileId = "openrouter:default";
      const stats = cooldown(reason);
      const store = makeStore({ [profileId]: stats, "inline-api-key:openrouter": stats });
      expect(isProfileInCooldown(store, profileId, now)).toBe(true);
      expect(resolveProfileUnusableUntilForDisplay(store, profileId)).toBe(until);
      expect(readInlineProviderApiKeyUsage(store, "openrouter").unusableUntil).toBe(until);
    },
  );

  it.each([
    ["rate_limit", "target", false, false, false],
    ["timeout", "target", true, false, false],
    ["auth", "target", true, true, true],
  ] as const)(
    "preserves the managed %s model scope",
    (reason, model, targetBlocked, siblingBlocked, accountBlocked) => {
      const profileId = "openrouter:default";
      const store = makeStore({ [profileId]: cooldown(reason, model) });
      expect(isProfileInCooldown(store, profileId, now, model)).toBe(targetBlocked);
      expect(isProfileInCooldown(store, profileId, now, "sibling")).toBe(siblingBlocked);
      expect(isProfileInCooldown(store, profileId, now, null)).toBe(accountBlocked);
    },
  );

  it("keeps model-scoped subscription blocks while ignoring managed transient cooldowns", () => {
    const profileId = "openrouter:default";
    const store = makeStore({
      [profileId]: cooldown("rate_limit", "target", {
        blockedUntil: until,
        blockedReason: "subscription_limit",
        blockedSource: "wham",
        blockedScope: "model",
        blockedModel: "target",
      }),
    });
    expect(isProfileInCooldown(store, profileId, now, "target")).toBe(true);
    expect(isProfileInCooldown(store, profileId, now, "sibling")).toBe(false);
    expect(isProfileInCooldown(store, profileId, now, null)).toBe(false);
    expect(getSoonestCooldownExpiry(store, [profileId], { now, forModel: "target" })).toBe(until);
    expect(getSoonestCooldownExpiry(store, [profileId], { now, forModel: "sibling" })).toBeNull();
  });

  type CooldownCase = [
    name: string,
    profileId: string,
    stats: ProfileUsageStats | undefined,
    checks: Array<[forModel: string | null | undefined, expected: boolean]>,
  ];
  const copilotChecks: CooldownCase[3] = [
    ["gpt-4.1", false],
    [sonnet, true],
    [undefined, true],
  ];
  const cooldownCases: CooldownCase[] = [
    ["missing stats", anthropic, undefined, [[undefined, false]]],
    ["expired cooldown", anthropic, { cooldownUntil: now - 1_000 }, [[undefined, false]]],
    [
      "active disable",
      anthropic,
      { cooldownUntil: now - 1_000, disabledUntil: until },
      [[undefined, true]],
    ],
    ["model-scoped rate limit", copilot, cooldown("rate_limit", sonnet), copilotChecks],
    [
      "model-scoped timeout (#87462)",
      "google:default",
      cooldown("timeout", gemini),
      [
        ["gemini-3.1-flash-lite", false],
        ["gemini-2.5-flash", false],
        [gemini, true],
        [undefined, true],
      ],
    ],
    ["model not found (#116464)", copilot, cooldown("model_not_found", sonnet), copilotChecks],
    [
      "model not found without a model (#116464)",
      copilot,
      cooldown("model_not_found"),
      [
        ["gpt-4.1", true],
        [sonnet, true],
      ],
    ],
    [
      "disable prevents sibling bypass",
      copilot,
      cooldown("rate_limit", sonnet, {
        disabledUntil: now + 120_000,
        disabledReason: "billing",
      }),
      [["gpt-4.1", true]],
    ],
    [
      "model-scoped block permits siblings",
      "google:default",
      cooldown("timeout", gemini, {
        blockedUntil: now + 120_000,
        blockedReason: "subscription_limit",
        blockedModel: gemini,
        blockedScope: "model",
      }),
      [
        [gemini, true],
        ["gemini-3.1-flash-lite", false],
      ],
    ],
    [
      "legacy blocks remain profile-wide",
      "google:default",
      { blockedUntil: now + 120_000, blockedModel: gemini },
      [["gemini-3.1-flash-lite", true]],
    ],
    [
      "account-wide ignores model cooldown",
      "openai:api-key",
      cooldown("rate_limit", "gpt-5.5"),
      [[null, false]],
    ],
    ["account-wide keeps profile cooldown", anthropic, cooldown("rate_limit"), [[null, true]]],
  ];
  it.each(cooldownCases)("checks cooldown: %s", (name, profileId, stats, checks) => {
    const store = makeStore(stats === undefined ? undefined : { [profileId]: stats });
    for (const [forModel, expected] of checks) {
      expect(
        isProfileInCooldown(store, profileId, now, forModel),
        `${name}: ${forModel ?? "profile-wide"}`,
      ).toBe(expected);
    }
  });

  it("excludes sibling models from model_not_found expiry (#116464)", () => {
    const store = makeStore({
      [copilot]: cooldown("model_not_found", sonnet),
    });
    const expiry = (forModel: string) =>
      getSoonestCooldownExpiry(store, [copilot], { now, forModel });
    expect(expiry(sonnet)).toBe(until);
    expect(expiry("gpt-4.1")).toBeNull();
  });

  const reasonCases: Array<
    [
      name: string,
      usageStats: AuthProfileStore["usageStats"],
      expected: ReturnType<typeof resolveProfilesUnavailableReason>,
    ]
  > = [
    [
      "explicit cooldown beats stale counts",
      { primary: cooldown("auth", undefined, { failureCounts: { rate_limit: 99 } }) },
      "auth",
    ],
    [
      "all sessions expired",
      {
        primary: cooldown(undefined, undefined, { failureCounts: { session_expired: 1 } }),
        backup: cooldown(undefined, undefined, { failureCounts: { session_expired: 1 } }),
      },
      "session_expired",
    ],
    [
      "most frequent reason",
      {
        primary: cooldown(undefined, undefined, {
          failureCounts: { overloaded: 2, rate_limit: 1 },
        }),
      },
      "overloaded",
    ],
    ["missing reason history", { primary: cooldown() }, "unknown"],
    [
      "expired windows",
      {
        primary: { cooldownUntil: now - 1_000, failureCounts: { auth: 5 } },
        backup: { disabledUntil: now - 500, disabledReason: "billing" },
      },
      null,
    ],
    [
      "priority breaks ties",
      { primary: cooldown(undefined, undefined, { failureCounts: { timeout: 2, auth: 2 } }) },
      "auth",
    ],
  ];
  it.each(reasonCases)("resolves unavailability reason: %s", (_name, usageStats, expected) => {
    expect(
      resolveProfilesUnavailableReason({
        store: makeStore(usageStats),
        profileIds: Object.keys(usageStats ?? {}),
        now,
      }),
    ).toBe(expected);
  });

  const unchangedCases: Array<[string, AuthProfileStore["usageStats"]]> = [
    ["missing stats", undefined],
    [
      "non-finite cooldowns",
      {
        primary: { cooldownUntil: Number.NaN, errorCount: 2 },
        backup: { cooldownUntil: Infinity, errorCount: 3 },
      },
    ],
    [
      "non-positive cooldowns",
      {
        primary: { cooldownUntil: 0, errorCount: 1 },
        backup: { cooldownUntil: -1, errorCount: 1 },
      },
    ],
  ];
  it.each(unchangedCases)("leaves %s unchanged", (_name, usageStats) => {
    const store = makeStore(structuredClone(usageStats));
    expect(clearExpiredCooldowns(store, now)).toBe(false);
    expect(store.usageStats).toEqual(usageStats);
  });

  const clearedCooldown = {
    cooldownUntil: undefined,
    cooldownReason: undefined,
    cooldownClassification: undefined,
    cooldownModel: undefined,
  };
  const clearedDisable = { disabledUntil: undefined, disabledReason: undefined };
  const expiryCases: Array<
    [name: string, before: ProfileUsageStats, after: ProfileUsageStats, useClock?: boolean]
  > = [
    [
      "expiry boundary clears classification",
      {
        cooldownUntil: now,
        cooldownClassification: "wham_token_expired",
        errorCount: 4,
        failureCounts: { timeout: 1 },
        lastFailureAt: now - 120_000,
      },
      { ...clearedCooldown, errorCount: 0, failureCounts: undefined, lastFailureAt: now - 120_000 },
    ],
    [
      "expired cooldown preserves active disable",
      {
        cooldownUntil: now - 1_000,
        disabledUntil: now + 3_600_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { rate_limit: 3, billing: 2 },
      },
      {
        ...clearedCooldown,
        disabledUntil: now + 3_600_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { rate_limit: 3, billing: 2 },
      },
    ],
    [
      "expired disable preserves active cooldown",
      {
        cooldownUntil: now + 300_000,
        disabledUntil: now - 1_000,
        disabledReason: "billing",
        errorCount: 3,
      },
      { cooldownUntil: now + 300_000, ...clearedDisable, errorCount: 3 },
    ],
    [
      "all expired windows preserve rate-limit history",
      {
        cooldownUntil: now - 2_000,
        disabledUntil: now - 1_000,
        disabledReason: "billing",
        errorCount: 4,
        failureCounts: { rate_limit: 2, billing: 2 },
      },
      { ...clearedCooldown, ...clearedDisable, errorCount: 0, failureCounts: { rate_limit: 2 } },
    ],
    [
      "expired provider block preserves retry backoff",
      {
        blockedUntil: now - 1_000,
        blockedReason: "subscription_limit",
        blockedSource: "codex_rate_limits",
        errorCount: 4,
        failureCounts: { rate_limit: 4, timeout: 2 },
        lastFailureAt: now - 120_000,
      },
      {
        blockedUntil: undefined,
        blockedReason: undefined,
        blockedSource: undefined,
        blockedModel: undefined,
        blockedScope: undefined,
        errorCount: 0,
        failureCounts: { rate_limit: 4 },
        lastFailureAt: now - 120_000,
      },
      true,
    ],
  ];
  it.each(expiryCases)("clears %s", (_name, before, after, useClock) => {
    const store = makeStore({ primary: structuredClone(before) });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(clearExpiredCooldowns(store, useClock ? undefined : now)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
    expect(store.usageStats).toEqual({ primary: after });
  });
});
