import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createAuthProfileUsageStore as makeStore } from "./credential-fixtures.test-support.js";
import type { ProfileUsageStats } from "./types.js";
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
  expect(
    resetAuthProfileFailureState(siblingSuccess, { lastUsed: 32_000 }, "primary"),
  ).toMatchObject({
    cooldownUntil: undefined,
    failureCounts: undefined,
    lastUsed: 32_000,
  });
});

const now = 1_700_000_000_000;
const until = now + 60_000;
const anthropic = "anthropic:default";
const copilot = "github-copilot:github";
const sonnet = "claude-sonnet-4.6";
const gemini = "gemini-3-flash-preview";
const openrouter = "openrouter:default";
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
const billingDisable: ProfileUsageStats = { disabledUntil: until, disabledReason: "billing" };
const modelBlock: ProfileUsageStats = {
  blockedUntil: until,
  blockedReason: "subscription_limit",
  blockedScope: "model",
  blockedModel: gemini,
};
const withFailures = (
  failureCounts: ProfileUsageStats["failureCounts"],
  reason?: ProfileUsageStats["cooldownReason"],
) => cooldown(reason, undefined, { failureCounts });
type Model = string | null | undefined;
const modelChecks = (blocked: Model[], allowed: Model[] = []): Array<[Model, boolean]> => [
  ...blocked.map((model): [Model, boolean] => [model, true]),
  ...allowed.map((model): [Model, boolean] => [model, false]),
];

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
      const profileId = openrouter;
      const raw = { ...cooldown(reason), cooldownUntil: now + 120_000 };
      const store = makeStore({ [profileId]: raw });
      expect(isProfileInCooldown(store, profileId, now)).toBe(false);
      expect(getSoonestCooldownExpiry(store, [profileId], { now })).toBeNull();
      expect(resolveProfileUnusableUntilForDisplay(store, profileId)).toBeNull();
      expect(resolveProfilesUnavailableReason({ store, profileIds: [profileId], now })).toBeNull();
      expect(readAuthProfileUsageStats(store, profileId)?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.[profileId]).toEqual(raw);

      for (const permanent of [
        billingDisable,
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
      const profileId = openrouter;
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
      const profileId = openrouter;
      const store = makeStore({ [profileId]: cooldown(reason, model) });
      expect(isProfileInCooldown(store, profileId, now, model)).toBe(targetBlocked);
      expect(isProfileInCooldown(store, profileId, now, "sibling")).toBe(siblingBlocked);
      expect(isProfileInCooldown(store, profileId, now, null)).toBe(accountBlocked);
    },
  );

  it("keeps model-scoped subscription blocks while ignoring managed transient cooldowns", () => {
    const profileId = openrouter;
    const store = makeStore({
      [profileId]: cooldown("rate_limit", "target", {
        ...modelBlock,
        blockedSource: "wham",
        blockedModel: "target",
      }),
    });
    expect(isProfileInCooldown(store, profileId, now, "target")).toBe(true);
    expect(isProfileInCooldown(store, profileId, now, "sibling")).toBe(false);
    expect(isProfileInCooldown(store, profileId, now, null)).toBe(false);
    expect(getSoonestCooldownExpiry(store, [profileId], { now, forModel: "target" })).toBe(until);
    expect(getSoonestCooldownExpiry(store, [profileId], { now, forModel: "sibling" })).toBeNull();
  });

  const scenario = (
    name: string,
    stats: ProfileUsageStats | undefined,
    checks: Array<[Model, boolean]>,
    profileId = anthropic,
  ) => ({ name, stats, checks, profileId });
  const copilotChecks = modelChecks([sonnet, undefined], ["gpt-4.1"]);
  it.each([
    scenario("missing stats", undefined, modelChecks([], [undefined])),
    scenario("expired cooldown", { cooldownUntil: now - 1_000 }, modelChecks([], [undefined])),
    scenario(
      "active disable",
      { cooldownUntil: now - 1_000, ...billingDisable },
      modelChecks([undefined]),
    ),
    scenario("scoped rate limit", cooldown("rate_limit", sonnet), copilotChecks, copilot),
    scenario(
      "scoped timeout (#87462)",
      cooldown("timeout", gemini),
      modelChecks([gemini, undefined], ["gemini-3.1-flash-lite", "gemini-2.5-flash"]),
      "google:default",
    ),
    scenario("not found (#116464)", cooldown("model_not_found", sonnet), copilotChecks, copilot),
    scenario(
      "unscoped not found (#116464)",
      cooldown("model_not_found"),
      modelChecks(["gpt-4.1", sonnet]),
      copilot,
    ),
    scenario(
      "disable prevents sibling bypass",
      cooldown("rate_limit", sonnet, { ...billingDisable, disabledUntil: now + 120_000 }),
      modelChecks(["gpt-4.1"]),
      copilot,
    ),
    scenario(
      "model-scoped block permits siblings",
      cooldown("timeout", gemini, { ...modelBlock, blockedUntil: now + 120_000 }),
      modelChecks([gemini], ["gemini-3.1-flash-lite"]),
      "google:default",
    ),
    scenario(
      "legacy blocks remain profile-wide",
      { blockedUntil: now + 120_000, blockedModel: gemini },
      modelChecks(["gemini-3.1-flash-lite"]),
      "google:default",
    ),
    scenario(
      "account-wide ignores model cooldown",
      cooldown("rate_limit", "gpt-5.5"),
      modelChecks([], [null]),
      "openai:api-key",
    ),
    scenario("account-wide keeps profile cooldown", cooldown("rate_limit"), modelChecks([null])),
  ])("checks cooldown: $name", ({ name, profileId, stats, checks }) => {
    const store = makeStore(stats === undefined ? undefined : { [profileId]: stats });
    for (const [forModel, expected] of checks) {
      expect(
        isProfileInCooldown(store, profileId, now, forModel),
        `${name}: ${forModel ?? "profile-wide"}`,
      ).toBe(expected);
    }
  });

  it("excludes sibling models from model_not_found expiry (#116464)", () => {
    const store = makeStore({ [copilot]: cooldown("model_not_found", sonnet) });
    const expiry = (forModel: string) =>
      getSoonestCooldownExpiry(store, [copilot], { now, forModel });
    expect(expiry(sonnet)).toBe(until);
    expect(expiry("gpt-4.1")).toBeNull();
  });

  const reasonCase = (
    name: string,
    expected: ReturnType<typeof resolveProfilesUnavailableReason>,
    primary: ProfileUsageStats,
    backup?: ProfileUsageStats,
  ) => ({ name, expected, usageStats: { primary, ...(backup ? { backup } : {}) } });
  it.each([
    reasonCase("explicit beats stale counts", "auth", withFailures({ rate_limit: 99 }, "auth")),
    reasonCase(
      "all sessions expired",
      "session_expired",
      withFailures({ session_expired: 1 }),
      withFailures({ session_expired: 1 }),
    ),
    reasonCase(
      "most frequent reason",
      "overloaded",
      withFailures({ overloaded: 2, rate_limit: 1 }),
    ),
    reasonCase("missing reason history", "unknown", cooldown()),
    reasonCase(
      "expired windows",
      null,
      { cooldownUntil: now - 1_000, failureCounts: { auth: 5 } },
      { disabledUntil: now - 500, disabledReason: "billing" },
    ),
    reasonCase("priority breaks ties", "auth", withFailures({ timeout: 2, auth: 2 })),
  ])("resolves unavailability reason: $name", ({ usageStats, expected }) => {
    expect(
      resolveProfilesUnavailableReason({
        store: makeStore(usageStats),
        profileIds: Object.keys(usageStats),
        now,
      }),
    ).toBe(expected);
  });

  it.each([
    ["missing stats", undefined],
    ["non-finite cooldowns", [Number.NaN, Infinity, 2, 3]],
    ["non-positive cooldowns", [0, -1, 1, 1]],
  ] as const)("leaves %s unchanged", (_name, values) => {
    const usageStats = values && {
      primary: { cooldownUntil: values[0], errorCount: values[2] },
      backup: { cooldownUntil: values[1], errorCount: values[3] },
    };
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
  const expires = (
    name: string,
    before: ProfileUsageStats,
    changed: ProfileUsageStats,
    useClock = false,
  ) => ({ name, before, after: { ...before, ...changed }, useClock });
  it.each([
    expires(
      "expiry boundary clears classification",
      {
        cooldownUntil: now,
        cooldownClassification: "wham_token_expired",
        errorCount: 4,
        failureCounts: { timeout: 1 },
        lastFailureAt: now - 120_000,
      },
      { ...clearedCooldown, errorCount: 0, failureCounts: undefined },
    ),
    expires(
      "expired cooldown preserves active disable",
      {
        cooldownUntil: now - 1_000,
        disabledUntil: now + 3_600_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { rate_limit: 3, billing: 2 },
      },
      clearedCooldown,
    ),
    expires(
      "expired disable preserves active cooldown",
      {
        cooldownUntil: now + 300_000,
        disabledUntil: now - 1_000,
        disabledReason: "billing",
        errorCount: 3,
      },
      clearedDisable,
    ),
    expires(
      "all expired windows preserve rate-limit history",
      {
        cooldownUntil: now - 2_000,
        disabledUntil: now - 1_000,
        disabledReason: "billing",
        errorCount: 4,
        failureCounts: { rate_limit: 2, billing: 2 },
      },
      { ...clearedCooldown, ...clearedDisable, errorCount: 0, failureCounts: { rate_limit: 2 } },
    ),
    expires(
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
      },
      true,
    ),
  ])("clears $name", ({ before, after, useClock }) => {
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
