// Quota recovery must re-enter normal auth preparation without hiding ownership/storage failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import {
  markOAuthRefreshFailureSettled,
  OAuthRefreshFailureError,
} from "./auth-profiles/oauth-refresh-failure.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
} from "./auth-profiles/oauth-refresh-marker.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
} from "./auth-profiles/usage-state.js";
import { FailoverError } from "./failover-error.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import { clearAgentHarnesses } from "./harness/registry.js";
import { runWithModelFallback as runWithModelFallbackBase } from "./model-fallback-runner.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

const authRuntimeMock = vi.hoisted(() => ({
  store: { version: 1, profiles: {} } as AuthProfileStore,
  runtime: { maybeReprobeWhamBlockedProfiles: vi.fn() },
}));

vi.mock("../infra/file-lock.js", () => ({
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));
vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
}));
vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
vi.mock("./auth-profiles/source-check.js", () => ({ hasAnyAuthProfileStoreSource: () => true }));
vi.mock("./auth-profiles.runtime.js", () => ({
  ...authRuntimeMock.runtime,
  ensureAuthProfileStore: () => authRuntimeMock.store,
  loadAuthProfileStoreForRuntime: () => authRuntimeMock.store,
  resolveAuthProfileOrder: ({ store, provider }: { store: AuthProfileStore; provider: string }) =>
    Object.entries(store.profiles)
      .filter(([, credential]) => credential.provider === provider)
      .map(([id]) => id),
  resolveAuthProfileEligibility: () => {
    throw new Error("Quota fixture has no user-locked profile");
  },
  isProfileInCooldown,
  getSoonestCooldownExpiry,
  resolveProfilesUnavailableReason,
}));

const runWithModelFallback: typeof runWithModelFallbackBase = (params) =>
  runWithModelFallbackBase({
    manifestPlugins: [],
    agentDir: `/tmp/openclaw-quota-recovery-mock/case-${++caseId}`,
    ...params,
  });
const makeProviderFallbackCfg = (provider: string) =>
  createModelFallbackConfig(`${provider}/m1`, ["fallback/ok-model"]);
let caseId = 0;

beforeEach(() => setLoggerOverride({ level: "silent", consoleLevel: "silent" }));
afterEach(() => {
  authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockReset();
  authRuntimeMock.store = { version: AUTH_STORE_VERSION, profiles: {} };
  resetFallbackSkipCacheForTest();
  clearAgentHarnesses();
  resetDiagnosticEventsForTest();
  setLoggerOverride(null);
  resetLogger();
});

describe("runWithModelFallback", () => {
  it.each([true, false])(
    "keeps normal auth failure under the existing fallback policy after quota refresh (allowed: %s)",
    async (allowed) => {
      const error = new OAuthRefreshFailureError({
        provider: "openai",
        profileId: "openai:default",
        message: "OAuth token refresh failed for openai: invalid_grant",
        reason: "invalid_grant",
      });
      markOAuthRefreshFailureSettled(error);
      authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockResolvedValueOnce({
        requiresAuthPreparation: true,
      });
      authRuntimeMock.store = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "oauth",
            provider: "openai",
            access: "expired-access",
            refresh: "synthetic-refresh",
            expires: 1,
          },
        },
      };
      const run = vi.fn(async (provider: string) => {
        if (provider === "openai") {
          throw error;
        }
        return "backup reply";
      });
      let normalizedFailure: unknown;
      const canFallbackAfterError = vi.fn(({ error: failure }: { error: unknown }) => {
        normalizedFailure = failure;
        return allowed;
      });
      const result = runWithModelFallback({
        cfg: makeProviderFallbackCfg("openai"),
        provider: "openai",
        model: "m1",
        run,
        canFallbackAfterError,
      });
      if (allowed) {
        expect((await result).result).toBe("backup reply");
        expect(run.mock.calls).toEqual([
          ["openai", "m1", expect.any(Object)],
          ["fallback", "ok-model", expect.any(Object)],
        ]);
      } else {
        const rejected = await result.catch((failure: unknown) => failure);
        expect(rejected).toBe(normalizedFailure);
        expect(run).toHaveBeenCalledOnce();
      }
      expect(normalizedFailure).toBeInstanceOf(FailoverError);
      expect(normalizedFailure).toMatchObject({
        reason: "auth_permanent",
        status: 403,
        provider: "openai",
        model: "m1",
        rawError: error.message,
      });
      if (!(normalizedFailure instanceof FailoverError)) {
        throw new Error("expected normalized auth failure");
      }
      expect(normalizedFailure.cause).toBe(error);
      expect(canFallbackAfterError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          error: normalizedFailure,
          provider: "openai",
          model: "m1",
          attempt: 1,
          total: 2,
        }),
      );
    },
  );

  it("keeps declared direct credentials after quota recovery instead of using a fallback", async () => {
    const profileId = "openai:default";
    const credential = {
      type: "oauth" as const,
      provider: "openai",
      access: "expired-access",
      refresh: "synthetic-refresh",
      expires: 1,
    };
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileId]: credential,
        "fallback:default": { type: "api_key", provider: "fallback", key: "fallback-key" },
      },
      usageStats: {
        [profileId]: {
          blockedUntil: Date.now() + 86_400_000,
          blockedReason: "subscription_limit",
          blockedSource: "wham",
        },
      },
    };
    authRuntimeMock.store = store;
    authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockImplementationOnce(async () => {
      store.profiles[profileId] = createFailedOAuthRefreshFence(
        createOAuthRefreshFence({ profileId, credential }),
      );
      return { requiresAuthPreparation: true };
    });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["fallback/ok-model"],
          },
        },
      },
      models: {
        providers: { openai: { apiKey: "configured-platform-key", baseUrl: "", models: [] } },
      },
    };
    const { prepareAuthFixture } = await import("./runtime-plan/prepare-auth.test-support.js");
    const run = vi.fn(async (provider: string, model: string) => {
      if (provider !== "openai") {
        return "fallback reply";
      }
      const prepared = prepareAuthFixture({
        provider,
        modelId: model,
        config: cfg,
        env: {},
        authProfileStore: store,
      });
      expect(prepared.attempts).toMatchObject([
        { kind: "direct", requiresPriorProfileAttempt: false },
      ]);
      expect(prepared.plan.credentialSource).toEqual({
        kind: "direct",
        evidence: "provider-config",
        authorization: "declared",
      });
      return "direct credential reply";
    });
    const canFallbackAfterError = vi.fn(() => false);
    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.5",
      run,
      canFallbackAfterError,
    });
    expect(result.result).toBe("direct credential reply");
    expect(run).toHaveBeenCalledExactlyOnceWith("openai", "gpt-5.5", expect.any(Object));
    expect(canFallbackAfterError).not.toHaveBeenCalled();
  });

  it("does not route quota storage constraints through provider fallback", async () => {
    const error = Object.assign(new Error("quota constraint invariant"), { errcode: 1811 });
    authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockRejectedValueOnce(error);
    const run = vi.fn();
    await expect(
      runWithModelFallback({
        cfg: makeProviderFallbackCfg("openai"),
        provider: "openai",
        model: "m1",
        run,
      }),
    ).rejects.toBe(error);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not mistake a wrapped quota cleanup failure for settled provider auth", async () => {
    const cause = new AggregateError([new Error("invalid_grant"), new Error("cleanup failed")]);
    const inner = new OAuthRefreshFailureError({
      provider: "openai",
      message: "OAuth refresh failed",
      cause,
      status: 401,
      reason: "invalid_grant",
    });
    const error = new OAuthRefreshFailureError({
      provider: "openai",
      message: inner.message,
      cause: inner,
    });
    authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockRejectedValueOnce(error);
    const run = vi.fn();
    await expect(
      runWithModelFallback({
        cfg: makeProviderFallbackCfg("openai"),
        provider: "openai",
        model: "m1",
        run,
      }),
    ).rejects.toBe(error);
    expect(run).not.toHaveBeenCalled();
  });
});
