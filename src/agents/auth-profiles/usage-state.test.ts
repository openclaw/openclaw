import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createAuthProfileUsageStore as makeStore } from "./credential-fixtures.test-support.js";
import type { ProfileUsageStats as Stats } from "./types.js";
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
  const existing: Stats = {
    cooldownReason: "rate_limit",
    cooldownModel: "primary",
    cooldownUntil: 31_000,
    lastRateLimitAt: 1_000,
  };
  const siblingSuccess = resetAuthProfileFailureState(existing, { lastUsed: 2_000 }, "fallback");
  expect(siblingSuccess).toMatchObject({ ...existing, lastUsed: 2_000 });
  expect(
    resetAuthProfileFailureState(siblingSuccess, { lastUsed: 32_000 }, "primary"),
  ).toMatchObject({
    cooldownUntil: undefined,
    lastRateLimitAt: undefined,
    lastUsed: 32_000,
  });
});

const now = 1_700_000_000_000;
const until = now + 60_000;
const later = now + 120_000;
const anthropic = "anthropic:default";
const copilot = "github-copilot:github";
const google = "google:default";
const sonnet = "claude-sonnet-4.6";
const gemini = "gemini-3-flash-preview";
const geminiLite = "gemini-3.1-flash-lite";
const openrouter = "openrouter:default";
const cooldown = (
  reason?: Stats["cooldownReason"],
  model?: string,
  extra: Partial<Stats> = {},
): Stats => ({
  cooldownUntil: until,
  cooldownReason: reason,
  cooldownModel: model,
  ...extra,
});
const billingDisable: Stats = { disabledUntil: until, disabledReason: "billing" };
const longerDisable = { ...billingDisable, disabledUntil: later };
const modelBlock: Stats = {
  blockedUntil: until,
  blockedReason: "subscription_limit",
  blockedScope: "model",
  blockedModel: gemini,
};
const longerBlock = { ...modelBlock, blockedUntil: later };
const withFailures = (failureCounts: Stats["failureCounts"], reason?: Stats["cooldownReason"]) =>
  cooldown(reason, undefined, { failureCounts });
type Model = string | null | undefined;
const checks = (blocked: Model[], allowed: Model[] = []): Array<[Model, boolean]> => [
  ...blocked.map((model): [Model, boolean] => [model, true]),
  ...allowed.map((model): [Model, boolean] => [model, false]),
];

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
  const cases: Array<[Stats, Model, number | null]> = [
    [{}, undefined, null],
    [{ cooldownUntil: 0, disabledUntil: Number.NaN }, undefined, null],
    [{ blockedUntil: MAX_DATE_TIMESTAMP_MS + 1 }, undefined, null],
    [{ ...modelBlock, ...cooldown("rate_limit", gemini) }, null, null],
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

it.each([
  ["rate_limit", true],
  ["overloaded", true],
  ["auth", false],
  [undefined, false],
] as const)("enforces managed %s and inline credential health", (reason, bypassed) => {
  const profileId = openrouter;
  const raw = { ...cooldown(reason), cooldownUntil: later };
  const store = makeStore({ [profileId]: raw, "inline-api-key:openrouter": raw });
  expect(isProfileInCooldown(store, profileId, now)).toBe(!bypassed);
  expect(getSoonestCooldownExpiry(store, [profileId], { now })).toBe(bypassed ? null : later);
  expect(resolveProfileUnusableUntilForDisplay(store, profileId)).toBe(bypassed ? null : later);
  expect(resolveProfilesUnavailableReason({ store, profileIds: [profileId], now })).toBe(
    bypassed ? null : (reason ?? "unknown"),
  );
  expect(readAuthProfileUsageStats(store, profileId)?.cooldownUntil).toBe(
    bypassed ? undefined : later,
  );
  expect(readInlineProviderApiKeyUsage(store, "openrouter").unusableUntil).toBe(later);
  expect(store.usageStats?.[profileId]).toEqual(raw);
  if (!bypassed) {
    return;
  }
  for (const permanent of [
    billingDisable,
    { disabledUntil: until, disabledReason: "auth_permanent" },
    { blockedUntil: until, blockedReason: "subscription_limit", blockedSource: "wham" },
  ] satisfies Partial<Stats>[]) {
    store.usageStats![profileId] = { ...raw, ...permanent };
    expect(isProfileInCooldown(store, profileId, now)).toBe(true);
    expect(getSoonestCooldownExpiry(store, [profileId], { now })).toBe(until);
    expect(resolveProfileUnusableUntilForDisplay(store, profileId)).toBe(until);
    expect(resolveProfilesUnavailableReason({ store, profileIds: [profileId], now })).toBe(
      "disabledReason" in permanent ? permanent.disabledReason : "rate_limit",
    );
  }
});

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
  stats: Stats | undefined,
  models: Array<[Model, boolean]>,
  profileId = anthropic,
) => ({ stats, models, profileId });
const copilotChecks = checks([sonnet, undefined], ["gpt-4.1"]);
const geminiChecks = checks([gemini, undefined], [geminiLite, "gemini-2.5-flash"]);
it.each([
  scenario(cooldown("rate_limit", "target"), checks([], ["target", "sibling", null]), openrouter),
  scenario(cooldown("timeout", "target"), checks(["target"], ["sibling", null]), openrouter),
  scenario(cooldown("auth", "target"), checks(["target", "sibling", null]), openrouter),
  scenario(undefined, checks([], [undefined])),
  scenario({ cooldownUntil: now - 1_000 }, checks([], [undefined])),
  scenario({ cooldownUntil: now - 1_000, ...billingDisable }, checks([undefined])),
  scenario(cooldown("rate_limit", sonnet), copilotChecks, copilot),
  scenario(cooldown("timeout", gemini), geminiChecks, google), // #87462
  scenario(cooldown("model_not_found", sonnet), copilotChecks, copilot), // #116464
  scenario(cooldown("model_not_found"), checks(["gpt-4.1", sonnet]), copilot),
  scenario(cooldown("rate_limit", sonnet, longerDisable), checks(["gpt-4.1"]), copilot),
  scenario(cooldown("timeout", gemini, longerBlock), checks([gemini], [geminiLite]), google),
  scenario({ blockedUntil: later, blockedModel: gemini }, checks([geminiLite]), google),
  scenario(cooldown("rate_limit", "gpt-5.5"), checks([], [null]), "openai:api-key"),
  scenario(cooldown("rate_limit"), checks([null])),
])("checks $profileId cooldown $stats", ({ profileId, stats, models }) => {
  const store = makeStore(stats === undefined ? undefined : { [profileId]: stats });
  for (const [forModel, expected] of models) {
    expect(isProfileInCooldown(store, profileId, now, forModel), `model: ${forModel}`).toBe(
      expected,
    );
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
  expected: ReturnType<typeof resolveProfilesUnavailableReason>,
  primary: Stats,
  backup?: Stats,
) => ({ expected, usageStats: { primary, ...(backup ? { backup } : {}) } });
it.each([
  reasonCase("auth", withFailures({ timeout: 99 }, "auth")),
  reasonCase(
    "session_expired",
    withFailures({ session_expired: 1 }),
    withFailures({ session_expired: 1 }),
  ),
  reasonCase("overloaded", withFailures({ overloaded: 2, timeout: 1 })),
  reasonCase("unknown", cooldown()),
  reasonCase(
    null,
    { cooldownUntil: now - 1_000, failureCounts: { auth: 5 } },
    { disabledUntil: now - 500, disabledReason: "billing" },
  ),
  reasonCase("auth", withFailures({ timeout: 2, auth: 2 })),
])("resolves $usageStats unavailability to $expected", ({ usageStats, expected }) => {
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
const expires = (name: string, before: Stats, changed: Stats, useClock = false) => ({
  name,
  before,
  after: { ...before, ...changed },
  useClock,
});
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
      failureCounts: { timeout: 3, billing: 2 },
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
    "all expired windows reset counters but keep rate-limit recovery",
    {
      cooldownUntil: now - 2_000,
      disabledUntil: now - 1_000,
      disabledReason: "billing",
      errorCount: 4,
      failureCounts: { timeout: 2, billing: 2 },
      lastRateLimitAt: now - 2_000,
    },
    { ...clearedCooldown, ...clearedDisable, errorCount: 0, failureCounts: undefined },
  ),
  expires(
    "expired provider block keeps rate-limit recovery",
    {
      blockedUntil: now - 1_000,
      blockedReason: "subscription_limit",
      blockedSource: "codex_rate_limits",
      errorCount: 4,
      failureCounts: { timeout: 2 },
      lastFailureAt: now - 120_000,
      lastRateLimitAt: now - 120_000,
    },
    {
      blockedUntil: undefined,
      blockedReason: undefined,
      blockedSource: undefined,
      blockedModel: undefined,
      blockedScope: undefined,
      errorCount: 0,
      failureCounts: undefined,
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
