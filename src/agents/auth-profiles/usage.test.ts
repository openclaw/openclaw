import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setLoggerOverride } from "../../logging/logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createApiKeyCredential,
  createAuthProfileUsageStore as makeStore,
} from "./credential-fixtures.test-support.js";
import {
  markOAuthRefreshFailureSettled,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";
import { createFailedOAuthRefreshFence, createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import * as oauth from "./oauth.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import {
  mockLockedUpdateForStore,
  mockLockedUpdatesForStore,
  resetAuthProfileUsageMocks,
  storeMocks,
  usageMocks,
} from "./usage-fixture.test-support.js";
import {
  clearExpiredCooldowns,
  isProfileInCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileFailure,
  maybeReprobeWhamBlockedProfiles,
  reconcileAuthProfileQuotaBlocks,
  resolveProfilesUnavailableReason,
} from "./usage.js";
import { testing as authProfileUsageTesting } from "./usage.test-support.js";

const codexId = "openai:default";
const anthropicId = "anthropic:default";
const copilotId = "github-copilot:github";
const testNow = 1_700_000_000_000;
type FailureReason = Parameters<typeof markAuthProfileFailure>[0]["reason"];
const codexStore = (stats?: ProfileUsageStats) =>
  makeStore(stats === undefined ? undefined : { [codexId]: stats });
const blockedStats = (now: number): ProfileUsageStats => ({
  blockedUntil: now + 86_400_000,
  blockedReason: "subscription_limit",
  blockedSource: "wham",
});
function oauthProfile(store: AuthProfileStore, profileId = codexId) {
  const profile = store.profiles[profileId];
  if (profile?.type !== "oauth") {
    throw new Error("expected OAuth fixture");
  }
  return profile;
}
function resolvedCredential(credential: ReturnType<typeof oauthProfile>, profileId = codexId) {
  return {
    apiKey: credential.access,
    provider: "openai",
    profileId,
    profileType: "oauth" as const,
    credential,
    readCurrentCredential: null,
  };
}
const whamWindow = (used_percent: number, reset_after_seconds: number) => ({
  used_percent,
  reset_after_seconds,
});
const whamResponse = (
  limit_reached: boolean,
  primary_window?: ReturnType<typeof whamWindow>,
  secondary_window?: ReturnType<typeof whamWindow>,
) => ({
  rate_limit: { limit_reached, primary_window, secondary_window },
});
function expiredQuota(now: number, stats = blockedStats(now)) {
  const store = codexStore(stats);
  const profile = oauthProfile(store);
  const expires = profile.expires;
  profile.expires = now - 1;
  return {
    store,
    profile,
    expires,
    refreshed: { ...profile, access: "refreshed-access", expires: now + 3_600_000 },
  };
}
function reprobe(
  store: AuthProfileStore,
  options: Partial<Omit<Parameters<typeof maybeReprobeWhamBlockedProfiles>[0], "store">> = {},
) {
  return maybeReprobeWhamBlockedProfiles({
    profileIds: [codexId],
    agentDir: "/tmp/quota-owner",
    ...options,
    store,
  });
}
const fetchMock = vi.hoisted(() => vi.fn());
const resolveApiKeyForProfileMock = vi.hoisted(() =>
  vi.fn<typeof import("./oauth.js").resolveApiKeyForProfile>(),
);

let resolveApiKeyForProfileSpy: MockInstance<typeof oauth.resolveApiKeyForProfile> | undefined;

// mock-isolation: Exercise quota planning and the real reducer without persistence workers.
vi.mock("./usage-write.js", async () => ({
  withAuthProfileUsage: (await import("./usage-fixture.test-support.js")).usageMocks
    .withAuthProfileUsage,
}));
// mock-isolation: Keep native auth-store I/O outside the in-memory quota fixture.
vi.mock(
  "./store-runtime.js",
  async () => (await import("./usage-fixture.test-support.js")).storeMocks,
);

beforeEach(() => {
  for (const mock of [...Object.values(storeMocks), fetchMock, resolveApiKeyForProfileMock]) {
    mock.mockReset();
  }
  storeMocks.resolvePersistedAuthProfileOwnerAgentDirAsync.mockImplementation(
    async (params: { agentDir?: string }) => params.agentDir,
  );
  resetAuthProfileUsageMocks();
  // Vitest can bypass manual factories during concurrent lazy imports. Keep both
  // quota operations on the same mocked export without serializing their work.
  resolveApiKeyForProfileSpy = vi
    .spyOn(oauth, "resolveApiKeyForProfile")
    .mockImplementation(resolveApiKeyForProfileMock);
  vi.stubGlobal("fetch", fetchMock);
  storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue({ version: 1, profiles: {} });
});

afterEach(() => {
  resolveApiKeyForProfileSpy?.mockRestore();
  resolveApiKeyForProfileSpy = undefined;
  authProfileUsageTesting.resetWhamReprobeStateForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function atTime(time: number, run: () => Promise<void>) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(time);
  try {
    await run();
  } finally {
    clock.mockRestore();
  }
}
async function markFailureAt(store: AuthProfileStore, reason: FailureReason, time: number) {
  mockLockedUpdateForStore(store);
  await atTime(time, () => markAuthProfileFailure({ store, profileId: anthropicId, reason }));
}

describe("failure retry windows (#23516)", () => {
  it("exponentially backs off rate limits without a provider reset up to 24 hours", async () => {
    const store = makeStore(undefined);
    let now = testNow;
    const delays = [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 1440, 1440].map(
      (minutes) => minutes * 60_000,
    );
    for (const [index, delay] of delays.entries()) {
      clearExpiredCooldowns(store, now);
      await markFailureAt(store, "rate_limit", now);
      expect(
        (store.usageStats?.[anthropicId]?.cooldownUntil ?? 0) - now,
        `attempt ${index + 1}`,
      ).toBe(delay);
      now += delay + 1;
    }
    expect(store.usageStats?.[anthropicId]?.failureCounts?.rate_limit).toBe(delays.length);
  });

  it("preserves rate-limit history through a differently classified failed probe", async () => {
    let now = testNow;
    const store = makeStore({
      [anthropicId]: {
        cooldownUntil: now - 1,
        cooldownReason: "rate_limit",
        errorCount: 3,
        failureCounts: { rate_limit: 3 },
        lastFailureAt: now - 60_000,
      },
    });
    await markFailureAt(store, "timeout", now);
    expect(store.usageStats?.[anthropicId]?.errorCount).toBe(1);
    expect(store.usageStats?.[anthropicId]?.failureCounts).toEqual({ rate_limit: 3, timeout: 1 });
    now = (store.usageStats?.[anthropicId]?.cooldownUntil ?? now) + 1;
    clearExpiredCooldowns(store, now);
    expect(store.usageStats?.[anthropicId]?.failureCounts).toEqual({ rate_limit: 3 });
    await markFailureAt(store, "rate_limit", now);
    expect(store.usageStats?.[anthropicId]).toMatchObject({
      cooldownUntil: now + 4 * 60_000,
      failureCounts: { rate_limit: 4 },
    });
  });

  it.each([
    ["keeps active disabledUntil", 20 * 60 * 60 * 1000, 5, 20 * 60 * 60 * 1000],
    ["recomputes expired disabledUntil", -60_000, 2, 10 * 60 * 1000],
  ] as const)("%s on retry", async (_name, offset, failures, expected) => {
    const now = 1_000_000;
    const store = makeStore({
      [anthropicId]: {
        disabledUntil: now + offset,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: failures },
        lastFailureAt: now - 60_000,
      },
    });
    await markFailureAt(store, "billing", now);
    expect(store.usageStats?.[anthropicId]?.disabledUntil).toBe(now + expected);
  });

  it.each([
    ["cooldownUntil", "rate_limit"],
    ["disabledUntil", "billing"],
  ] as const)("keeps recomputed %s inside the valid Date range", async (field, reason) => {
    const store = makeStore({});
    await markFailureAt(store, reason, MAX_DATE_TIMESTAMP_MS);
    expect(store.usageStats?.[anthropicId]?.[field]).toBe(MAX_DATE_TIMESTAMP_MS);
  });
});

describe("markAuthProfileBlockedUntil", () => {
  const model = "gpt-5.4";
  const sibling = "gpt-5.4-mini";
  it.each([
    ["same model stays scoped", false, model, model, [true, false]],
    ["different model widens", false, sibling, undefined, [true]],
    ["profile-wide never narrows", true, model, undefined, [true]],
  ] as const)("%s", async (_name, wide, incomingModel, expectedModel, checks) => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const store = codexStore({
      blockedUntil: now + (wide ? 120_000 : 60_000),
      ...(!wide ? { blockedModel: model, blockedScope: "model" as const } : {}),
      ...(checks.length === 2 ? { cooldownClassification: "wham_token_expired" as const } : {}),
    });
    mockLockedUpdateForStore(store);
    await atTime(now, () =>
      markAuthProfileBlockedUntil({
        store,
        profileId: codexId,
        blockedUntil: now + (wide ? 60_000 : 120_000),
        source: "codex_rate_limits",
        modelId: incomingModel,
      }),
    );
    expect(store.usageStats?.[codexId]).toMatchObject({
      blockedModel: expectedModel,
      blockedScope: expectedModel ? "model" : undefined,
      ...(wide ? { blockedUntil: now + 120_000 } : {}),
      ...(checks.length === 2 ? { cooldownClassification: undefined } : {}),
    });
    const models = checks.length === 2 ? [model, sibling] : [sibling];
    expect(models.map((id) => isProfileInCooldown(store, codexId, now, id))).toEqual(checks);
  });

  it("ignores blocked-until updates outside the valid Date range", async () => {
    const store = makeStore({});
    mockLockedUpdateForStore(store);
    await markAuthProfileBlockedUntil({
      store,
      profileId: codexId,
      blockedUntil: Number.MAX_SAFE_INTEGER,
      source: "codex_rate_limits",
    });
    expect(store.usageStats).toEqual({});
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });
});

it("does not persist unverifiable failures for API-key profiles", async () => {
  const store = makeStore(undefined);
  store.profiles["azure-foundry:default"] = createApiKeyCredential("azure-foundry", "test-key");

  for (const profileId of ["azure-foundry:default", "openai:api-key"]) {
    await markAuthProfileFailure({ store, profileId, reason: "no_error_details" });
  }

  expect(store.usageStats).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(usageMocks.withAuthProfileUsage).not.toHaveBeenCalled();
  expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
});

it("drops bookkeeping without an unlocked full-store save", async () => {
  const store = makeStore(undefined);
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  usageMocks.record.mockResolvedValueOnce(null);
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  try {
    await markAuthProfileFailure({ store, profileId: anthropicId, reason: "rate_limit" });
    expect(store.usageStats).toBeUndefined();
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
    expect(
      consoleWarn.mock.calls.some(([line]) =>
        String(line).includes("dropped auth profile bookkeeping after locked store update failed"),
      ),
    ).toBe(true);
  } finally {
    setLoggerOverride(null);
    consoleWarn.mockRestore();
  }
});

describe("markAuthProfileFailure — WHAM-aware Codex cooldowns", () => {
  function mockWhamResponse(status: number, body?: unknown): void {
    fetchMock.mockResolvedValueOnce(
      new Response(body === undefined ? "{}" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  async function markCodexFailureAt({
    store = makeStore({}),
    reason = "rate_limit",
    modelId,
    mockLock = true,
  }: {
    store?: AuthProfileStore;
    reason?: "auth" | "rate_limit" | "no_error_details" | "unknown";
    modelId?: string;
    mockLock?: boolean;
  } = {}) {
    storeMocks.loadAuthProfileStoreWithoutExternalProfilesAsync.mockResolvedValue(store);
    if (mockLock) {
      mockLockedUpdateForStore(store);
    }
    await atTime(testNow, () =>
      markAuthProfileFailure({ store, profileId: codexId, reason, modelId }),
    );
    return store;
  }

  it.each([true, false])(
    "shares expired-credential recovery and waits for quota capacity (available: %s)",
    async (available) => {
      const now = Date.now();
      const blockedUntil = now + 86_400_000;
      const { store, refreshed } = expiredQuota(now);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      resolveApiKeyForProfileMock.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        store.profiles[codexId] = refreshed;
        return resolvedCredential(refreshed, codexId);
      });
      mockLockedUpdatesForStore(store);
      mockWhamResponse(
        200,
        available ? whamResponse(false) : whamResponse(true, whamWindow(100, 3600)),
      );
      const params = {
        store,
        profileIds: [codexId],
        agentDir: "/tmp/quota-owner",
        cfg: {},
      };
      const probes = [
        maybeReprobeWhamBlockedProfiles(params),
        maybeReprobeWhamBlockedProfiles(params),
      ];
      try {
        await Promise.race([entered.promise, Promise.all(probes)]);
        expect(resolveApiKeyForProfileMock).toHaveBeenCalledOnce();
        expect(resolveApiKeyForProfileMock).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId: codexId,
            agentDir: params.agentDir,
            cfg: params.cfg,
            allowProfileFallback: false,
          }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.usageStats?.[codexId]?.blockedUntil).toBe(blockedUntil);
      } finally {
        release.resolve();
        await Promise.all(probes);
      }
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer refreshed-access");
      expect(store.profiles[codexId]).toEqual(refreshed);
      if (available) {
        expect(store.usageStats?.[codexId]?.blockedUntil).toBeUndefined();
      } else {
        expect(store.usageStats?.[codexId]?.blockedReason).toBe("subscription_limit");
        expect(store.usageStats?.[codexId]?.blockedUntil).toBeGreaterThan(now);
      }
    },
  );

  it.each(["replaced credential", "removed credential"] as const)(
    "does not probe an expired recovery after a %s",
    async (change) => {
      const now = Date.now();
      const { store, refreshed } = expiredQuota(now);
      resolveApiKeyForProfileMock.mockImplementation(async () => {
        if (change === "removed credential") {
          delete store.profiles[codexId];
        } else {
          store.profiles[codexId] = { ...refreshed, access: "replacement-access" };
        }
        return resolvedCredential(refreshed, codexId);
      });
      mockLockedUpdatesForStore(store);
      await reprobe(store);
      expect(resolveApiKeyForProfileMock).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.usageStats?.[codexId]?.blockedUntil).toBe(now + 86_400_000);
    },
  );

  it("keeps a healthy caller-selected profile omitted from auth order after another refresh fails", async () => {
    const now = Date.now();
    const { store, profile, expires } = expiredQuota(now, {
      blockedUntil: now + 86_400_000,
      blockedReason: "subscription_limit",
    });
    store.profiles["openai:healthy"] = {
      ...profile,
      access: "healthy-access",
      expires,
    };
    const failure = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: codexId,
      message: "refresh rejected",
    });
    markOAuthRefreshFailureSettled(failure);
    resolveApiKeyForProfileMock.mockRejectedValueOnce(failure);
    mockLockedUpdatesForStore(store);
    const dispatch = vi.fn();
    await reprobe(store, {
      profileIds: [codexId, "openai:healthy"],
      cfg: { auth: { order: { openai: [codexId] } } },
    }).then(dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(store.profiles["openai:healthy"]?.type).toBe("oauth");
    expect(isProfileInCooldown(store, "openai:healthy")).toBe(false);
    expect(isProfileInCooldown(store, "openai:default")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("joins peer quota work before surfacing an unclassified refresh failure", async () => {
    const now = Date.now();
    const blocked = {
      blockedUntil: now + 86_400_000,
      blockedReason: "subscription_limit" as const,
    };
    const store = makeStore({ [codexId]: blocked, "openai:peer": { ...blocked } });
    const profile = oauthProfile(store, codexId);
    profile.expires = now - 1;
    store.profiles["openai:peer"] = { ...profile };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new OAuthRefreshFailureError({
      provider: "openai",
      message: "refresh failed",
      cause: Object.assign(new Error("disk I/O error"), { errcode: 778 }),
    });
    resolveApiKeyForProfileMock.mockImplementation(async ({ profileId }) => {
      if (profileId === "openai:default") {
        throw failure;
      }
      entered.resolve();
      await release.promise;
      const refreshed = { ...profile, access: "peer-access", expires: now + 3_600_000 };
      store.profiles[profileId] = refreshed;
      return resolvedCredential(refreshed, profileId);
    });
    mockLockedUpdatesForStore(store);
    mockWhamResponse(200, whamResponse(false));
    let settled = false;
    const probe = reprobe(store, { profileIds: [codexId, "openai:peer"] });
    const observation = probe
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    try {
      await Promise.race([entered.promise, observation]);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await observation;
    }
    await expect(probe).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.usageStats?.["openai:peer"]?.blockedUntil).toBeUndefined();
  });

  it.each(["settled error", "unclassified error", "no credential"] as const)(
    "keeps normal auth preparation after credential recovery (%s)",
    async (outcome) => {
      const now = Date.now();
      const profileId = "openai:default";
      const store = makeStore({
        [profileId]: { blockedUntil: now + 86_400_000, blockedReason: "subscription_limit" },
      });
      const profile = oauthProfile(store, profileId);
      profile.expires = now - 1;
      store.profiles = { [profileId]: profile };
      const failure = new OAuthRefreshFailureError({
        provider: "openai",
        profileId,
        message: "refresh failed",
      });
      if (outcome === "settled error") {
        markOAuthRefreshFailureSettled(failure);
      }
      resolveApiKeyForProfileMock.mockImplementationOnce(async () => {
        store.profiles[profileId] = createFailedOAuthRefreshFence(
          createOAuthRefreshFence({ profileId, credential: profile }),
        );
        if (outcome === "no credential") {
          return null;
        }
        throw failure;
      });
      mockLockedUpdatesForStore(store);
      const config: OpenClawConfig = {
        models: {
          providers: { openai: { apiKey: "configured-platform-key", baseUrl: "", models: [] } },
        },
      };
      const params = {
        provider: "openai",
        modelId: "gpt-5.5",
        authProfileStore: store,
        config,
        agentDir: "/tmp/quota-owner",
      };
      const reconciliation =
        outcome === "no credential"
          ? maybeReprobeWhamBlockedProfiles({
              store,
              profileIds: [profileId],
              cfg: config,
              agentDir: params.agentDir,
            })
          : reconcileAuthProfileQuotaBlocks(params);
      if (outcome === "unclassified error") {
        await expect(reconciliation).rejects.toBe(failure);
        return;
      }
      const result = await reconciliation;
      if (outcome === "no credential") {
        expect(result).toEqual({ requiresAuthPreparation: true });
      }
      const { prepareAuthFixture } = await import("../runtime-plan/prepare-auth.test-support.js");
      const prepared = prepareAuthFixture({ ...params, env: {} });
      expect(prepared.attempts).toMatchObject([
        { kind: "direct", requiresPriorProfileAttempt: false },
      ]);
      expect(prepared.plan.credentialSource).toEqual({
        kind: "direct",
        evidence: "provider-config",
        authorization: "declared",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.usageStats?.[profileId]?.blockedUntil).toBe(now + 86_400_000);
    },
  );

  it("re-arms a stale WHAM block from the latest blocked snapshot", async () => {
    const now = testNow;
    prepareSharedAuthStoreOwnershipForNative();
    const store = codexStore({
      blockedUntil: now + 6 * 24 * 60 * 60 * 1000,
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      blockedModel: "gpt-5.5",
      blockedScope: "model",
    });
    mockWhamResponse(200, whamResponse(true, whamWindow(100, 3_600)));
    mockLockedUpdatesForStore(store);
    await atTime(now, async () => {
      await maybeReprobeWhamBlockedProfiles({
        store,
        profileIds: [codexId],
        forModel: "gpt-5.5",
        now,
      });
      await vi.waitFor(() => {
        expect(store.usageStats?.[codexId]?.blockedUntil).toBe(now + 3_600_000);
      });
    });
    expect(store.usageStats?.[codexId]?.lastProbeAt).toBe(now);
    expect(store.usageStats?.[codexId]?.blockedModel).toBe("gpt-5.5");
    expect(store.usageStats?.[codexId]?.blockedScope).toBe("model");
  });

  const available = whamResponse(false, whamWindow(45, 9_000));
  it.each([
    ["fresh burst", available, 15_000, "fresh"],
    ["active burst", available, 6 * 3_600_000, "cooldown"],
    [
      "team rolling",
      whamResponse(true, whamWindow(100, 7_200), whamWindow(85, 201_600)),
      7_200_000,
      "blocked",
    ],
    [
      "team weekly",
      whamResponse(true, whamWindow(90, 7_200), whamWindow(100, 28_800)),
      28_800_000,
      "blocked",
    ],
  ] as const)("maps %s to the expected cooldown", async (_name, response, expectedMs, state) => {
    const now = testNow;
    const store = makeStore(
      state === "fresh"
        ? undefined
        : {
            [codexId]: {
              cooldownUntil: now + 6 * 60 * 60 * 1000,
              cooldownReason: "rate_limit",
              errorCount: 12,
              failureCounts: { rate_limit: 12 },
              lastFailureAt: now - 1_000,
            },
          },
    );
    mockWhamResponse(200, response);

    await markCodexFailureAt({ store });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toMatchObject([
      "https://chatgpt.com/backend-api/wham/usage",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer codex-access-token",
          "ChatGPT-Account-Id": "acct_test_123",
          originator: "openclaw",
          "User-Agent": expect.stringMatching(/^openclaw\//),
        },
      },
    ]);
    const stats = store.usageStats?.[codexId];
    expect(stats?.lastProbeAt).toBe(now);
    if (state === "blocked") {
      expect(stats?.blockedUntil).toBe(now + expectedMs);
      expect(stats?.blockedReason).toBe("subscription_limit");
      expect(stats?.cooldownUntil).toBeUndefined();
    } else {
      expect(stats?.cooldownUntil).toBe(now + expectedMs);
    }
  });

  it("does not apply a stale WHAM result after the profile changes", async () => {
    const store = makeStore(undefined);
    mockWhamResponse(200, whamResponse(false, whamWindow(45, 9_000)));
    const freshStore = structuredClone(store);
    freshStore.profiles[codexId] = createApiKeyCredential("openai", "rotated-api-key");
    usageMocks.readFresh.mockReturnValueOnce(store).mockReturnValue(freshStore);

    await markCodexFailureAt({ store, reason: "no_error_details", mockLock: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.usageStats).toBeUndefined();
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });

  it.each([
    [401, 12, "auth", "wham_token_expired"],
    [403, 24, "auth_permanent", "wham_account_dead"],
  ] as const)(
    "persists WHAM HTTP %s auth classification and fallback reason",
    async (status, hours, reason, classification) => {
      const now = testNow;
      mockWhamResponse(status);
      const store = await markCodexFailureAt({ modelId: "gpt-5.6-luna" });
      expect(store.usageStats?.[codexId]).toMatchObject({
        cooldownUntil: now + hours * 3_600_000,
        cooldownReason: reason,
        cooldownClassification: classification,
        cooldownModel: undefined,
      });
      expect(resolveProfilesUnavailableReason({ store, profileIds: [codexId], now })).toBe(reason);
    },
  );

  it.each(["chatgpt-token-sharing", "chatgpt-identity"])(
    "keeps %s credentials out of Codex quota probes",
    async (authFlow) => {
      const now = testNow;
      const store = makeStore({});
      const profile = oauthProfile(store, codexId);
      profile.authFlow = authFlow;
      mockWhamResponse(401);

      await markCodexFailureAt({ store });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.usageStats?.[codexId]?.cooldownUntil).toBe(now + 30_000);

      const block = {
        blockedUntil: now + 86_400_000,
        blockedReason: "subscription_limit" as const,
      };
      store.usageStats = { [codexId]: { ...block } };
      await maybeReprobeWhamBlockedProfiles({ store, profileIds: [codexId], now });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.usageStats[codexId]).toEqual(block);
    },
  );

  it("skips WHAM probe for locally expired OAuth access tokens", async () => {
    const now = testNow;
    const store = codexStore({ cooldownClassification: "wham_token_expired" });
    const profile = oauthProfile(store, codexId);
    profile.expires = now - 1;
    mockWhamResponse(401);

    await markCodexFailureAt({ store });

    expect(fetchMock).not.toHaveBeenCalled();
    const stats = store.usageStats?.[codexId];
    expect(stats?.cooldownUntil).toBe(now + 30_000);
    expect(stats?.cooldownReason).toBe("rate_limit");
    expect(stats?.cooldownClassification).toBeUndefined();
  });

  it("cancels WHAM HTTP error response bodies", async () => {
    const now = testNow;
    const response = new Response("server busy", { status: 500 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(response);

    const store = await markCodexFailureAt();

    expect(cancel).toHaveBeenCalledOnce();
    expect(store.usageStats?.[codexId]?.cooldownUntil).toBe(now + 30_000);
  });

  it("falls back to a 30s cooldown when the WHAM probe fails", async () => {
    const now = testNow;
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
    const store = await markCodexFailureAt({ reason: "unknown" });

    expect(store.usageStats?.[codexId]?.cooldownUntil).toBe(now + 30_000);
  });

  it.each([
    ["reset_after_seconds", { reset_after_seconds: Number.MAX_SAFE_INTEGER }],
    ["reset_at", { reset_at: Number.MAX_SAFE_INTEGER }],
  ])("does not pin profiles from unsafe WHAM %s values", async (_label, resetFields) => {
    const now = testNow;
    const store = makeStore({});
    mockWhamResponse(200, {
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 100, ...resetFields },
      },
    });

    await markCodexFailureAt({ store });

    const stats = store.usageStats?.[codexId];
    expect(stats?.blockedUntil).toBeUndefined();
    expect(stats?.cooldownUntil).toBe(now + 30_000);
    expect(stats?.cooldownReason).toBe("rate_limit");
  });
});

describe("markAuthProfileFailure — per-model cooldown metadata", () => {
  const now = 1_000_000;
  const sonnet = "claude-sonnet-4.6";
  const activeStats = (reason: FailureReason): ProfileUsageStats => ({
    cooldownUntil: now + 30_000,
    cooldownReason: reason,
    cooldownModel: sonnet,
    errorCount: 1,
    lastFailureAt: now - 1_000,
  });
  type ModelCase = {
    name: string;
    reason: FailureReason;
    before?: ProfileUsageStats;
    modelId?: string;
    expectedModel?: string | null;
    until?: number;
    checkSibling?: boolean;
    realTime?: boolean;
  };
  const cases: ModelCase[] = [
    { name: "first rate limit", reason: "rate_limit" },
    {
      name: "same-model not-found retry",
      reason: "model_not_found",
      before: activeStats("model_not_found"),
      until: now + 30_000,
    },
    {
      name: "not-found keeps sibling available (#116464)",
      reason: "model_not_found",
      checkSibling: true,
    },
    {
      name: "different model widens",
      reason: "rate_limit",
      before: activeStats("rate_limit"),
      modelId: "gpt-4.1",
      expectedModel: null,
    },
    {
      name: "auth supersedes rate limit",
      reason: "auth",
      before: activeStats("rate_limit"),
      modelId: "claude-opus-4.6",
      expectedModel: null,
      realTime: true,
    },
  ];

  it.each(cases)("$name", async (row) => {
    const modelId = row.modelId ?? sonnet;
    const store = makeStore({ [copilotId]: structuredClone(row.before ?? {}) });
    store.profiles[copilotId] = createApiKeyCredential("github-copilot", "ghu_test");
    if (!row.realTime) {
      vi.useFakeTimers();
      vi.setSystemTime(now);
    }
    mockLockedUpdateForStore(store);
    await markAuthProfileFailure({ store, profileId: copilotId, reason: row.reason, modelId });
    expect(store.usageStats?.[copilotId]).toMatchObject({
      cooldownReason: row.reason,
      cooldownModel: row.expectedModel === null ? undefined : (row.expectedModel ?? sonnet),
      ...(row.until !== undefined ? { cooldownUntil: row.until } : {}),
    });
    if (row.checkSibling) {
      expect(
        [sonnet, "gpt-4.1"].map((id) => isProfileInCooldown(store, copilotId, now, id)),
      ).toEqual([true, false]);
    }
  });
});
