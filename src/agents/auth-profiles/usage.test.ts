import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
vi.mock("./store-runtime.js", async () => {
  const { storeMocks: mocks } = await import("./usage-fixture.test-support.js");
  return {
    loadAuthProfileStoreWithoutExternalProfilesAsync:
      mocks.loadAuthProfileStoreWithoutExternalProfilesAsync,
    resolvePersistedAuthProfileOwnerAgentDirAsync:
      mocks.resolvePersistedAuthProfileOwnerAgentDirAsync,
    updateAuthProfileStoreWithLock: mocks.updateAuthProfileStoreWithLock,
    saveAuthProfileStore: mocks.saveAuthProfileStore,
  };
});

beforeEach(() => {
  storeMocks.resolvePersistedAuthProfileOwnerAgentDirAsync.mockReset();
  storeMocks.resolvePersistedAuthProfileOwnerAgentDirAsync.mockImplementation(
    async (params: { agentDir?: string }) => params.agentDir,
  );
  storeMocks.saveAuthProfileStore.mockReset();
  storeMocks.loadAuthProfileStoreWithoutExternalProfilesAsync.mockReset();
  storeMocks.updateAuthProfileStoreWithLock.mockReset();
  resetAuthProfileUsageMocks();
  fetchMock.mockReset();
  resolveApiKeyForProfileMock.mockReset();
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

describe("markAuthProfileFailure — active windows do not extend on retry", () => {
  // Regression for https://github.com/openclaw/openclaw/issues/23516
  // When all providers are at saturation backoff (60 min) and retries fire every 30 min,
  // each retry was resetting cooldownUntil to now+60m, preventing recovery.
  type WindowStats = ProfileUsageStats;

  async function markFailureAt(params: {
    store: ReturnType<typeof makeStore>;
    now: number;
    reason: "rate_limit" | "timeout" | "billing" | "auth_permanent";
    cfg?: OpenClawConfig;
  }): Promise<void> {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(params.now);
    mockLockedUpdateForStore(params.store);
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: anthropicId,
        reason: params.reason,
        cfg: params.cfg,
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  }

  it("exponentially backs off rate limits without a provider reset up to 24 hours", async () => {
    const store = makeStore(undefined);
    let now = testNow;
    const expectedDelays = [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 1440, 1440].map(
      (minutes) => minutes * 60_000,
    );

    for (const [index, expectedDelay] of expectedDelays.entries()) {
      clearExpiredCooldowns(store, now);
      await markFailureAt({ store, now, reason: "rate_limit" });
      const stats = store.usageStats?.[anthropicId];
      expect((stats?.cooldownUntil ?? 0) - now, `attempt ${index + 1}`).toBe(expectedDelay);
      now += expectedDelay + 1;
    }

    expect(store.usageStats?.[anthropicId]?.failureCounts?.rate_limit).toBe(expectedDelays.length);
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

    await markFailureAt({ store, now, reason: "timeout" });
    expect(store.usageStats?.[anthropicId]?.errorCount).toBe(1);
    expect(store.usageStats?.[anthropicId]?.failureCounts).toEqual({
      rate_limit: 3,
      timeout: 1,
    });

    now = (store.usageStats?.[anthropicId]?.cooldownUntil ?? now) + 1;
    clearExpiredCooldowns(store, now);
    expect(store.usageStats?.[anthropicId]?.failureCounts).toEqual({ rate_limit: 3 });

    await markFailureAt({ store, now, reason: "rate_limit" });
    expect(store.usageStats?.[anthropicId]?.failureCounts?.rate_limit).toBe(4);
    expect((store.usageStats?.[anthropicId]?.cooldownUntil ?? 0) - now).toBe(4 * 60_000);
  });

  it("keeps active disabledUntil unchanged on retry", async () => {
    const now = 1_000_000;
    const store = makeStore({
      [anthropicId]: {
        disabledUntil: now + 20 * 60 * 60 * 1000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 5 },
        lastFailureAt: now - 60_000,
      },
    });
    await markFailureAt({ store, now, reason: "billing" });
    expect(store.usageStats?.[anthropicId]?.disabledUntil).toBe(now + 20 * 60 * 60 * 1000);
  });

  it("recomputes disabledUntil after the previous window expires", async () => {
    const now = 1_000_000;
    const store = makeStore({
      [anthropicId]: {
        disabledUntil: now - 60_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 2 },
        lastFailureAt: now - 60_000,
      },
    });
    await markFailureAt({ store, now, reason: "billing" });
    expect(store.usageStats?.[anthropicId]?.disabledUntil).toBe(now + 10 * 60 * 1000);
  });

  it.each([
    {
      label: "cooldownUntil",
      reason: "rate_limit" as const,
      readUntil: (stats: WindowStats | undefined) => stats?.cooldownUntil,
    },
    {
      label: "disabledUntil",
      reason: "billing" as const,
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
  ])("keeps recomputed $label inside the valid Date range", async (testCase) => {
    const store = makeStore({});

    await markFailureAt({
      store,
      now: MAX_DATE_TIMESTAMP_MS,
      reason: testCase.reason,
    });

    const stats = store.usageStats?.[anthropicId];
    expect(testCase.readUntil(stats)).toBe(MAX_DATE_TIMESTAMP_MS);
  });
});

describe("markAuthProfileBlockedUntil", () => {
  async function applyBlockedUntil(params: {
    store: AuthProfileStore;
    blockedUntil: number;
    now?: number;
    modelId?: string;
  }): Promise<void> {
    const nowSpy =
      params.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    mockLockedUpdateForStore(params.store);
    try {
      await markAuthProfileBlockedUntil({
        store: params.store,
        profileId: codexId,
        blockedUntil: params.blockedUntil,
        source: "codex_rate_limits",
        modelId: params.modelId,
      });
    } finally {
      nowSpy?.mockRestore();
    }
  }

  it("keeps repeated same-model blocks scoped to that model", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const store = codexStore({
      blockedUntil: now + 60_000,
      blockedModel: "gpt-5.4",
      blockedScope: "model",
      cooldownClassification: "wham_token_expired",
    });
    await applyBlockedUntil({ store, now, blockedUntil: now + 120_000, modelId: "gpt-5.4" });

    expect(store.usageStats?.[codexId]).toMatchObject({
      blockedModel: "gpt-5.4",
      blockedScope: "model",
      cooldownClassification: undefined,
    });
    expect(isProfileInCooldown(store, codexId, now, "gpt-5.4")).toBe(true);
    expect(isProfileInCooldown(store, codexId, now, "gpt-5.4-mini")).toBe(false);
  });

  it("widens an active block after a different model fails", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const store = codexStore({
      blockedUntil: now + 60_000,
      blockedModel: "gpt-5.4",
      blockedScope: "model",
    });
    await applyBlockedUntil({ store, now, blockedUntil: now + 120_000, modelId: "gpt-5.4-mini" });

    expect(store.usageStats?.[codexId]).toMatchObject({
      blockedModel: undefined,
      blockedScope: undefined,
    });
    expect(isProfileInCooldown(store, codexId, now, "gpt-5.4-mini")).toBe(true);
  });

  it("never narrows an active profile-wide block", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const store = codexStore({
      blockedUntil: now + 120_000,
    });
    await applyBlockedUntil({ store, now, blockedUntil: now + 60_000, modelId: "gpt-5.4" });

    expect(store.usageStats?.[codexId]).toMatchObject({
      blockedUntil: now + 120_000,
      blockedModel: undefined,
      blockedScope: undefined,
    });
    expect(isProfileInCooldown(store, codexId, now, "gpt-5.4-mini")).toBe(true);
  });

  it("ignores blocked-until updates outside the valid Date range", async () => {
    const store = makeStore({});
    await applyBlockedUntil({ store, blockedUntil: Number.MAX_SAFE_INTEGER });

    expect(store.usageStats).toEqual({});
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });
});

describe("markAuthProfileFailure — detail-less provider failures", () => {
  it("does not persist unverifiable failures for API-key profiles", async () => {
    const store = makeStore(undefined);
    store.profiles["azure-foundry:default"] = createApiKeyCredential(
      "azure-foundry",
      "azure-foundry-test-key",
    );

    for (const profileId of ["azure-foundry:default", "openai:api-key"]) {
      await markAuthProfileFailure({
        store,
        profileId,
        reason: "no_error_details",
      });
    }

    expect(store.usageStats).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(usageMocks.withAuthProfileUsage).not.toHaveBeenCalled();
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });
});

describe("markAuthProfileFailure — worker update failure", () => {
  it("drops bookkeeping without an unlocked full-store save", async () => {
    const store = makeStore(undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    usageMocks.record.mockResolvedValueOnce(null);
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    try {
      await markAuthProfileFailure({
        store,
        profileId: anthropicId,
        reason: "rate_limit",
      });
      expect(store.usageStats).toBeUndefined();
      expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
      expect(
        consoleWarn.mock.calls.some(([line]) =>
          String(line).includes(
            "dropped auth profile bookkeeping after locked store update failed",
          ),
        ),
      ).toBe(true);
    } finally {
      setLoggerOverride(null);
      consoleWarn.mockRestore();
    }
  });
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

  async function markCodexFailureAt(params: {
    store: ReturnType<typeof makeStore>;
    now: number;
    reason?: "auth" | "rate_limit" | "no_error_details" | "unknown";
    modelId?: string;
    mockLock?: boolean;
  }): Promise<void> {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(params.now);
    storeMocks.loadAuthProfileStoreWithoutExternalProfilesAsync.mockResolvedValue(params.store);
    if (params.mockLock !== false) {
      mockLockedUpdateForStore(params.store);
    }
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: codexId,
        reason: params.reason ?? "rate_limit",
        modelId: params.modelId,
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  }

  it.each([true, false])(
    "shares expired-credential recovery and waits for quota capacity (available: %s)",
    async (available) => {
      const now = Date.now();
      const blockedUntil = now + 86_400_000;
      const store = codexStore({
        blockedUntil,
        blockedReason: "subscription_limit",
        blockedSource: "wham",
      });
      const profile = oauthProfile(store, codexId);
      profile.expires = now - 1;
      const refreshed = { ...profile, access: "refreshed-access", expires: now + 3_600_000 };
      const entered = createDeferredCore();
      const release = createDeferredCore();
      resolveApiKeyForProfileMock.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        store.profiles[codexId] = refreshed;
        return resolvedCredential(refreshed, codexId);
      });
      mockLockedUpdatesForStore(store);
      mockWhamResponse(200, {
        rate_limit: available
          ? { limit_reached: false }
          : {
              limit_reached: true,
              primary_window: { used_percent: 100, reset_after_seconds: 3600 },
            },
      });
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
      const store = codexStore(blockedStats(now));
      const profile = oauthProfile(store, codexId);
      profile.expires = now - 1;
      const refreshed = { ...profile, access: "refreshed-access", expires: now + 3_600_000 };
      resolveApiKeyForProfileMock.mockImplementation(async () => {
        if (change === "removed credential") {
          delete store.profiles[codexId];
        } else {
          store.profiles[codexId] = { ...refreshed, access: "replacement-access" };
        }
        return resolvedCredential(refreshed, codexId);
      });
      mockLockedUpdatesForStore(store);
      await maybeReprobeWhamBlockedProfiles({
        store,
        profileIds: [codexId],
        agentDir: "/tmp/quota-owner",
      });
      expect(resolveApiKeyForProfileMock).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.usageStats?.[codexId]?.blockedUntil).toBe(now + 86_400_000);
    },
  );

  it("keeps a healthy caller-selected profile omitted from auth order after another refresh fails", async () => {
    const now = Date.now();
    const store = codexStore({
      blockedUntil: now + 86_400_000,
      blockedReason: "subscription_limit",
    });
    const profile = oauthProfile(store, codexId);
    store.profiles["openai:healthy"] = { ...profile, access: "healthy-access" };
    profile.expires = now - 1;
    const failure = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: codexId,
      message: "refresh rejected",
    });
    markOAuthRefreshFailureSettled(failure);
    resolveApiKeyForProfileMock.mockRejectedValueOnce(failure);
    mockLockedUpdatesForStore(store);
    const dispatch = vi.fn();
    await maybeReprobeWhamBlockedProfiles({
      store,
      profileIds: ["openai:default", "openai:healthy"],
      agentDir: "/tmp/quota-owner",
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
      return {
        apiKey: refreshed.access,
        provider: "openai",
        profileId,
        profileType: "oauth",
        credential: refreshed,
        readCurrentCredential: null,
      };
    });
    mockLockedUpdatesForStore(store);
    mockWhamResponse(200, whamResponse(false));
    let settled = false;
    let observedFailure: unknown;
    let outcome = "pending";
    const probe = maybeReprobeWhamBlockedProfiles({
      store,
      profileIds: ["openai:default", "openai:peer"],
      agentDir: "/tmp/quota-owner",
    });
    const observation = probe.then(
      () => {
        outcome = "fulfilled";
        settled = true;
      },
      (error: unknown) => {
        observedFailure = error;
        outcome = "rejected";
        settled = true;
      },
    );
    try {
      await Promise.race([entered.promise, observation]);
      expect(
        settled,
        JSON.stringify({
          outcome,
          attemptedProfileIds: resolveApiKeyForProfileMock.mock.calls.map(
            ([params]) => params.profileId,
          ),
          failure: observedFailure === undefined ? undefined : formatErrorMessage(observedFailure),
        }),
      ).toBe(false);
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
    prepareSharedAuthStoreOwnershipForNative();
    const now = testNow;
    const store = codexStore({
      blockedUntil: now + 6 * 24 * 60 * 60 * 1000,
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      blockedModel: "gpt-5.5",
      blockedScope: "model",
    });
    mockWhamResponse(200, whamResponse(true, whamWindow(100, 3_600)));
    mockLockedUpdatesForStore(store);
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      await maybeReprobeWhamBlockedProfiles({
        store,
        profileIds: [codexId],
        forModel: "gpt-5.5",
        now,
      });
      await vi.waitFor(() => {
        expect(store.usageStats?.[codexId]?.blockedUntil).toBe(now + 3_600_000);
      });
    } finally {
      dateNowSpy.mockRestore();
    }
    expect(store.usageStats?.[codexId]?.lastProbeAt).toBe(now);
    expect(store.usageStats?.[codexId]?.blockedModel).toBe("gpt-5.5");
    expect(store.usageStats?.[codexId]?.blockedScope).toBe("model");
  });

  it.each([
    {
      label: "burst contention without an active cooldown",
      fresh: true,
      response: whamResponse(false, whamWindow(45, 9_000)),
      expectedMs: 15_000,
    },
    {
      label: "burst contention with an active cooldown",
      response: whamResponse(false, whamWindow(45, 9_000)),
      expectedMs: 6 * 60 * 60 * 1000,
    },
    {
      label: "team rolling window",
      response: whamResponse(true, whamWindow(100, 7_200), whamWindow(85, 201_600)),
      expectedMs: 7_200_000,
      exactBlocked: true,
    },
    {
      label: "team weekly window",
      response: whamResponse(true, whamWindow(90, 7_200), whamWindow(100, 28_800)),
      expectedMs: 28_800_000,
      exactBlocked: true,
    },
  ])(
    "maps $label to the expected cooldown",
    async ({ response, expectedMs, exactBlocked, fresh }) => {
      const now = testNow;
      const store = makeStore(
        fresh
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

      await markCodexFailureAt({ store, now });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls.at(0) as [string, RequestInit];
      expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(init.method).toBe("GET");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer codex-access-token");
      expect(headers["ChatGPT-Account-Id"]).toBe("acct_test_123");
      expect(headers.originator).toBe("openclaw");
      expect(headers["User-Agent"]).toMatch(/^openclaw\//);
      const stats = store.usageStats?.[codexId];
      expect(stats?.lastProbeAt).toBe(now);
      if (exactBlocked) {
        expect(stats?.blockedUntil).toBe(now + expectedMs);
        expect(stats?.blockedReason).toBe("subscription_limit");
        expect(stats?.cooldownUntil).toBeUndefined();
      } else {
        expect(stats?.cooldownUntil).toBe(now + expectedMs);
      }
    },
  );

  it("does not apply a stale WHAM result after the profile changes", async () => {
    const now = testNow;
    const store = makeStore(undefined);
    mockWhamResponse(200, whamResponse(false, whamWindow(45, 9_000)));
    const freshStore = structuredClone(store);
    freshStore.profiles[codexId] = createApiKeyCredential("openai", "rotated-api-key");
    usageMocks.readFresh.mockReturnValueOnce(store).mockReturnValue(freshStore);

    await markCodexFailureAt({ store, now, reason: "no_error_details", mockLock: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.usageStats).toBeUndefined();
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 401,
      expectedMs: 12 * 60 * 60 * 1000,
      expectedCooldownReason: "auth",
      expectedCooldownClassification: "wham_token_expired",
      expectedUnavailableReason: "auth",
    },
    {
      status: 403,
      expectedMs: 24 * 60 * 60 * 1000,
      expectedCooldownReason: "auth_permanent",
      expectedCooldownClassification: "wham_account_dead",
      expectedUnavailableReason: "auth_permanent",
    },
  ])(
    "persists WHAM HTTP $status auth classification and canonical fallback reason",
    async ({
      status,
      expectedMs,
      expectedCooldownReason,
      expectedCooldownClassification,
      expectedUnavailableReason,
    }) => {
      const now = testNow;
      const store = makeStore({});
      mockWhamResponse(status);

      await markCodexFailureAt({ store, now, modelId: "gpt-5.6-luna" });

      const stats = store.usageStats?.[codexId];
      expect(stats?.cooldownUntil).toBe(now + expectedMs);
      expect(stats?.cooldownReason).toBe(expectedCooldownReason);
      expect(stats?.cooldownClassification).toBe(expectedCooldownClassification);
      expect(stats?.cooldownModel).toBeUndefined();
      expect(
        resolveProfilesUnavailableReason({
          store,
          profileIds: [codexId],
          now,
        }),
      ).toBe(expectedUnavailableReason);
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

      await markCodexFailureAt({ store, now });
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

    await markCodexFailureAt({ store, now });

    expect(fetchMock).not.toHaveBeenCalled();
    const stats = store.usageStats?.[codexId];
    expect(stats?.cooldownUntil).toBe(now + 30_000);
    expect(stats?.cooldownReason).toBe("rate_limit");
    expect(stats?.cooldownClassification).toBeUndefined();
  });

  it("cancels WHAM HTTP error response bodies", async () => {
    const now = testNow;
    const store = makeStore({});
    const response = new Response("server busy", { status: 500 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(response);

    await markCodexFailureAt({ store, now });

    expect(cancel).toHaveBeenCalledOnce();
    expect(store.usageStats?.[codexId]?.cooldownUntil).toBe(now + 30_000);
  });

  it("falls back to a 30s cooldown when the WHAM probe fails", async () => {
    const now = testNow;
    const store = makeStore({});
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));

    await markCodexFailureAt({ store, now, reason: "unknown" });

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

    await markCodexFailureAt({ store, now });

    const stats = store.usageStats?.[codexId];
    expect(stats?.blockedUntil).toBeUndefined();
    expect(stats?.cooldownUntil).toBe(now + 30_000);
    expect(stats?.cooldownReason).toBe("rate_limit");
  });
});

describe("markAuthProfileFailure — per-model cooldown metadata", () => {
  type FailureReason = Parameters<typeof markAuthProfileFailure>[0]["reason"];

  function makeStoreWithCopilot(usageStats: AuthProfileStore["usageStats"]): AuthProfileStore {
    const store = makeStore(usageStats);
    store.profiles[copilotId] = createApiKeyCredential("github-copilot", "ghu_test");
    return store;
  }

  async function markFailure(params: {
    store: ReturnType<typeof makeStoreWithCopilot>;
    now: number;
    reason: FailureReason;
    modelId?: string;
    useFakeTime?: boolean;
  }): Promise<void> {
    if (params.useFakeTime !== false) {
      vi.useFakeTimers();
      vi.setSystemTime(params.now);
    }
    mockLockedUpdateForStore(params.store);
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: copilotId,
        reason: params.reason,
        modelId: params.modelId,
      });
    } finally {
      if (params.useFakeTime !== false) {
        vi.useRealTimers();
      }
    }
  }

  const now = 1_000_000;
  const activeStats = (
    reason: FailureReason,
    modelId: string,
  ): NonNullable<AuthProfileStore["usageStats"]>[string] => ({
    cooldownUntil: now + 30_000,
    cooldownReason: reason,
    cooldownModel: modelId,
    errorCount: 1,
    lastFailureAt: now - 1_000,
  });
  type ModelCase = [
    name: string,
    initialStats: ProfileUsageStats,
    reason: FailureReason,
    modelId: string,
    expectedModel: string | undefined,
    options?: {
      expectedUntil?: number;
      availability?: Array<{ modelId: string; expected: boolean }>;
      useFakeTime?: boolean;
    },
  ];
  const sonnet = "claude-sonnet-4.6";
  const cases: ModelCase[] = [
    ["records model on first rate_limit", {}, "rate_limit", sonnet, sonnet],
    [
      "preserves model on repeated model_not_found",
      activeStats("model_not_found", sonnet),
      "model_not_found",
      sonnet,
      sonnet,
      { expectedUntil: now + 30_000 },
    ],
    [
      "keeps healthy sibling after model_not_found (#116464)",
      {},
      "model_not_found",
      sonnet,
      sonnet,
      {
        availability: [
          { modelId: sonnet, expected: true },
          { modelId: "gpt-4.1", expected: false },
        ],
      },
    ],
    [
      "widens model scope when a different model fails",
      activeStats("rate_limit", sonnet),
      "rate_limit",
      "gpt-4.1",
      undefined,
    ],
    [
      "auth failure supersedes active rate_limit",
      activeStats("rate_limit", sonnet),
      "auth",
      "claude-opus-4.6",
      undefined,
      { useFakeTime: false },
    ],
  ];

  it.each(cases)("%s", async (name, initialStats, reason, modelId, expectedModel, options = {}) => {
    const store = makeStoreWithCopilot({ [copilotId]: structuredClone(initialStats) });
    await markFailure({ store, now, reason, modelId, useFakeTime: options.useFakeTime });
    const stats = store.usageStats?.[copilotId];
    expect(stats?.cooldownReason, name).toBe(reason);
    expect(stats?.cooldownModel, name).toBe(expectedModel);
    if (options.expectedUntil !== undefined) {
      expect(stats?.cooldownUntil).toBe(options.expectedUntil);
    }
    for (const availability of options.availability ?? []) {
      expect(
        isProfileInCooldown(store, copilotId, now, availability.modelId),
        `${name}: ${availability.modelId}`,
      ).toBe(availability.expected);
    }
  });
});
