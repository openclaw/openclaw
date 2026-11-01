import "../../auth-profiles/external-auth.test-support.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { isSecretValueRegisteredForRedaction } from "../../../logging/secret-redaction-registry.js";
import { SecretSurfaceUnavailableError } from "../../../secrets/runtime-degraded-state.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../../../secrets/sentinel.js";
import { createOAuthRefreshError } from "../../../shared/oauth-refresh-outcome.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { createOAuthManager } from "../../auth-profiles/oauth-manager.js";
import { mockOAuthProviderOperations } from "../../auth-profiles/oauth-native-provider.test-support.js";
import { OAuthRefreshFailureError } from "../../auth-profiles/oauth-refresh-failure.js";
import { resolveAuthProfileOrder } from "../../auth-profiles/order.js";
import { loadPersistedAuthProfileStore } from "../../auth-profiles/persisted.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../../auth-profiles/store-runtime.js";
import { FailoverError } from "../../failover-error.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";

const mocks = vi.hoisted(() => ({
  prepareProviderRuntimeAuth: vi.fn(),
  getApiKeyForModelCore: vi.fn(),
}));

vi.mock("../../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../plugins/provider-runtime.js")>(
    "../../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
  };
});

vi.mock("../../model-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../model-auth.js")>("../../model-auth.js");
  return {
    ...actual,
    getApiKeyForModelCore: mocks.getApiKeyForModelCore,
  };
});

import {
  createEmbeddedRunAuthController,
  resolveEmbeddedAuthCooldownProbePolicy,
  type EmbeddedRunAuthState,
} from "./auth-controller.js";

function createTestModel(): Model {
  return makeProviderModelFixture({
    id: "test-model",
    provider: "custom-openai",
    api: "openai-responses",
    baseUrl: "https://old.example.com/v1",
    headers: { Authorization: "Bearer stale-token" },
    contextWindow: 8_000,
    maxTokens: 4_000,
  });
}

type RuntimeApiKeySetter = Mock<(provider: string, apiKey: string) => void>;
let harness: EmbeddedRunAuthState;
let setRuntimeApiKey: RuntimeApiKeySetter;

function apiKeyAuth(apiKey: string | undefined, source = "env", profileId?: string) {
  return { apiKey, mode: "api-key" as const, source, ...(profileId ? { profileId } : {}) };
}

function runtimeAuth(
  apiKey: string,
  value: string,
  baseUrl?: string,
  expiresAt?: number,
  headerName = "api-key",
) {
  return {
    apiKey,
    request: { auth: { mode: "header" as const, headerName, value } },
    ...(baseUrl ? { baseUrl } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function profileAuth(profileId: string | undefined, suffix = "-key") {
  return apiKeyAuth(`${String(profileId)}${suffix}`, `profile:${String(profileId)}`, profileId);
}

function keyProfile(key: string) {
  return { type: "api_key" as const, provider: "custom-openai", key };
}

function expectProtected(value: string | null | undefined, plaintext: string): void {
  expect(value).not.toBe(plaintext);
  expect(looksLikeSecretSentinel(value ?? "")).toBe(true);
  expect(resolveSecretSentinel(value ?? "")).toBe(plaintext);
}

type ControllerParams = Parameters<typeof createEmbeddedRunAuthController>[0];
function createController(params: Partial<ControllerParams> = {}) {
  return createEmbeddedRunAuthController({
    config: undefined,
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    authStore: { version: 1, profiles: {} },
    authStorage: { setRuntimeApiKey },
    profileCandidates: ["default"],
    initialThinkLevel: "medium",
    attemptedThinking: new Set(),
    fallbackConfigured: false,
    allowTransientCooldownProbe: false,
    provider: harness.models.runtime.provider,
    modelId: "test-model",
    state: harness,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    },
    ...params,
  });
}

beforeEach(() => {
  harness = {
    models: { runtime: createTestModel(), effective: createTestModel() },
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    runtimeAuthRefreshCancelled: false,
    profileIndex: 0,
    thinkLevel: "medium",
  };
  setRuntimeApiKey = vi.fn();
  mocks.prepareProviderRuntimeAuth.mockReset();
  mocks.getApiKeyForModelCore.mockReset();
});

it.each(["credential resolution", "runtime auth exchange", "AWS runtime auth exchange"])(
  "ends a hung %s at the run timeout without installing credentials",
  async (step) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let exchangeSignal: AbortSignal | undefined;
    const late = createDeferred<{ apiKey: string }>();
    mocks.getApiKeyForModelCore.mockImplementation(({ signal }) => {
      if (step === "credential resolution") {
        exchangeSignal = signal;
        return late.promise;
      }
      return Promise.resolve(
        step.startsWith("AWS")
          ? { mode: "aws-sdk", source: "aws-sdk default chain" }
          : apiKeyAuth("synthetic-source"),
      );
    });
    mocks.prepareProviderRuntimeAuth.mockImplementation(({ context }) => {
      exchangeSignal = context.signal;
      return late.promise;
    });
    const controller = createController({ timeoutMs: 100 });
    onTestFinished(() => controller.stopRuntimeAuthRefreshTimer());
    const result = controller.initializeAuthProfile().then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    const outcome = await Promise.race([result, Promise.resolve("still pending")]);
    expect(outcome).toMatchObject({
      name: "AbortError",
      message: expect.stringMatching(/custom-openai.*timed out.*100ms/i),
    });
    expect(outcome).toHaveProperty("message", expect.stringContaining(step.replace("AWS ", "")));
    expect(exchangeSignal?.aborted).toBe(true);
    late.resolve({ apiKey: "synthetic-late-token" });
    await vi.advanceTimersByTimeAsync(0);
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
    expect(harness.runtimeAuthState).toBeNull();
  },
);

it.each([false, true])(
  "settles slow runtime auth inside the budget (cancelled: %s)",
  async (cancelled) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const abort = new AbortController();
    let exchangeSignal: AbortSignal | undefined;
    mocks.getApiKeyForModelCore.mockResolvedValue(apiKeyAuth("synthetic-source"));
    mocks.prepareProviderRuntimeAuth.mockImplementation(({ context }) => {
      exchangeSignal = context.signal;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ apiKey: "synthetic-runtime" }), 50);
      });
    });
    const controller = createController({ timeoutMs: 100, signal: abort.signal });
    onTestFinished(() => controller.stopRuntimeAuthRefreshTimer());
    const result = controller.initializeAuthProfile().then(
      () => "success",
      () => "aborted",
    );
    await vi.advanceTimersByTimeAsync(25);
    if (cancelled) {
      abort.abort();
    }
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toBe(cancelled ? "aborted" : "success");
    if (cancelled) {
      expect(exchangeSignal?.aborted).toBe(true);
      expect(setRuntimeApiKey).not.toHaveBeenCalled();
    } else {
      expectProtected(setRuntimeApiKey.mock.calls[0]?.[1], "synthetic-runtime");
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("shares the run deadline across credential lookup and token exchange", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  mocks.getApiKeyForModelCore.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(apiKeyAuth("synthetic-source")), 60);
      }),
  );
  mocks.prepareProviderRuntimeAuth.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ apiKey: "synthetic-runtime" }), 60);
      }),
  );
  const controller = createController({ timeoutMs: 100 });
  onTestFinished(() => controller.stopRuntimeAuthRefreshTimer());
  const result = controller.initializeAuthProfile().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject({
    name: "AbortError",
    message: expect.stringContaining("runtime auth exchange timed out"),
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(setRuntimeApiKey).not.toHaveBeenCalled();
});

it("can select API-key auth after stopping a forwarded harness candidate", async () => {
  mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) => profileAuth(profileId));
  mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
  const controller = createController({ profileCandidates: ["default", "backup"] });
  onTestFinished(() => controller.close());
  await controller.initializeAuthProfile();
  controller.stopRuntimeAuthRefreshTimer();
  await controller.applyAuthProfileCandidate("backup");
  expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "backup-key");
});

it.each([false, true])(
  "recovers expired SIWC auth without runtime exchange state (refresh fails: %s)",
  async (refreshFails) => {
    harness.models.runtime.provider = "openai";
    const auth = {
      apiKey: "synthetic-old-access",
      mode: "oauth",
      authFlow: "chatgpt-token-sharing",
      profileId: "openai:siwc",
      source: "profile",
    };
    mocks.getApiKeyForModelCore.mockResolvedValueOnce(auth).mockImplementation(async (params) => {
      expect(params).toMatchObject({
        profileId: auth.profileId,
        forceRefresh: true,
        lockedProfile: true,
      });
      if (refreshFails) {
        throw new Error("synthetic refresh failure");
      }
      return { ...auth, apiKey: "synthetic-renewed-access" };
    });
    const controller = createController({
      profileCandidates: [auth.profileId],
      fallbackConfigured: true,
    });
    await controller.initializeAuthProfile();
    expect(harness.runtimeAuthState).toBeNull();
    const error =
      '401 {"error":{"code":"token_expired","message":"Provided authentication token is expired."}}';
    await expect(controller.maybeRefreshRuntimeAuthForAuthError(error, false)).resolves.toBe(
      !refreshFails,
    );
    expect(setRuntimeApiKey).toHaveBeenLastCalledWith(
      "openai",
      refreshFails ? "synthetic-old-access" : "synthetic-renewed-access",
    );
    await expect(controller.maybeRefreshRuntimeAuthForAuthError(error, true)).resolves.toBe(false);
    expect(mocks.getApiKeyForModelCore).toHaveBeenCalledTimes(2);
    expect(harness.lastProfileId).toBe(auth.profileId);
  },
);

it.each([
  ["openai", "api-key", undefined, "401 token_expired"],
  ["openai", "oauth", undefined, "401 token_expired"],
  ["custom-openai", "oauth", "chatgpt-token-sharing", "401 token_expired"],
  ["openai", "oauth", "chatgpt-token-sharing", "401 invalid api key"],
] satisfies [string, string, string | undefined, string][])(
  "does not force-refresh unrelated auth: %s/%s/%s/%s",
  async (provider, mode, authFlow, error) => {
    harness.models.runtime.provider = provider;
    mocks.getApiKeyForModelCore.mockResolvedValue({
      apiKey: "synthetic-access",
      mode,
      authFlow,
      profileId: "default",
      source: "profile",
    });
    const controller = createController();
    await controller.initializeAuthProfile();
    await expect(controller.maybeRefreshRuntimeAuthForAuthError(error, false)).resolves.toBe(false);
    expect(mocks.getApiKeyForModelCore).toHaveBeenCalledOnce();
  },
);

it("commits a prepared route only after its credential resolves", async () => {
  const selectedModel = {
    ...createTestModel(),
    api: "openai-chatgpt-responses" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    contextWindow: 272_000,
  };
  mocks.getApiKeyForModelCore.mockImplementation(async ({ model }) => {
    expect(model).toBe(selectedModel);
    expect(harness.models.runtime).not.toBe(selectedModel);
    return {
      apiKey: "subscription-token",
      mode: "oauth" as const,
      profileId: "openai:chatgpt",
      source: "profile",
    };
  });
  mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);

  const controller = createController({
    profileCandidates: ["openai:chatgpt"],
    prepareModelForAuthProfile: async () => ({
      runtimeModel: selectedModel,
      authRequirement: "subscription",
      commit: () => {
        harness.models.runtime = selectedModel;
        harness.models.effective = selectedModel;
      },
    }),
  });

  await controller.initializeAuthProfile();
  expect(harness.models.runtime).toBe(selectedModel);
  expect(harness.lastProfileId).toBe("openai:chatgpt");
});

it("rejects credentials whose class does not match the prepared route", async () => {
  const commit = vi.fn();
  mocks.getApiKeyForModelCore.mockResolvedValue(apiKeyAuth("platform-key", "config"));

  const controller = createController({
    profileCandidates: ["default"],
    prepareModelForAuthProfile: async () => ({
      runtimeModel: {
        ...createTestModel(),
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      authRequirement: "subscription",
      commit,
    }),
  });

  await expect(controller.initializeAuthProfile()).rejects.toThrow(
    "api-key credentials are incompatible with the selected subscription route",
  );
  expect(commit).not.toHaveBeenCalled();
});

it("applies runtime request overrides on the first auth exchange", async () => {
  mocks.getApiKeyForModelCore.mockResolvedValue(apiKeyAuth("source-api-key", "env", "default"));
  mocks.prepareProviderRuntimeAuth.mockResolvedValue(
    runtimeAuth("runtime-api-key", "runtime-header-token", "https://runtime.example.com/v1"),
  );
  const controller = createController();

  await controller.initializeAuthProfile();

  expect(mocks.getApiKeyForModelCore.mock.calls.at(0)?.[0]).toMatchObject({
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
  });
  for (const model of [harness.models.runtime, harness.models.effective]) {
    expect(model.baseUrl).toBe("https://runtime.example.com/v1");
    expectProtected(model.headers?.["api-key"], "runtime-header-token");
  }
  expectProtected(setRuntimeApiKey.mock.calls[0]?.[1], "runtime-api-key");
  expectProtected(harness.runtimeAuthState?.apiKey, "runtime-api-key");
  expect(harness.runtimeAuthState).toMatchObject({
    sourceApiKey: "source-api-key",
    authMode: "api-key",
    profileId: "default",
  });

  for (const apiKey of ["refreshed-runtime-api-key", "twice-refreshed-runtime-api-key"]) {
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({ apiKey });
    await expect(
      controller.maybeRefreshRuntimeAuthForAuthError("401 invalid api key", false),
    ).resolves.toBe(true);
    expectProtected(harness.runtimeAuthState?.apiKey, apiKey);
    expectProtected(setRuntimeApiKey.mock.calls.at(-1)?.[1], apiKey);
    expect(harness.runtimeAuthState?.sourceApiKey).toBe("source-api-key");
  }
});

it("does not rotate profiles after an explicit SecretRef owner becomes unavailable", async () => {
  const unavailable = new SecretSurfaceUnavailableError({
    ownerKind: "account",
    ownerId: "openai:cold",
    state: "unavailable",
    paths: ["auth-profiles.openai:cold.key"],
    refKeys: ["env:default:MISSING_OPENAI_KEY"],
    reason: "secret reference was not found",
  });
  mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) => {
    if (profileId === "default") {
      throw unavailable;
    }
    return apiKeyAuth("unused", `profile:${String(profileId)}`, profileId);
  });
  const controller = createController({
    profileCandidates: ["default", "backup"],
  });

  await expect(controller.initializeAuthProfile()).rejects.toBe(unavailable);
  expect(mocks.getApiKeyForModelCore).toHaveBeenCalledOnce();
  expect(mocks.prepareProviderRuntimeAuth).not.toHaveBeenCalled();
});

it("clears prior runtime-auth transport overrides when rotating profiles", async () => {
  const baseModel = {
    ...createTestModel(),
    headers: { "x-base": "base" },
  };
  harness.models.runtime = baseModel;
  harness.models.effective = baseModel;

  mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) =>
    profileAuth(profileId, "-source-key"),
  );
  mocks.prepareProviderRuntimeAuth.mockImplementation(async ({ context }) =>
    context.profileId === "default"
      ? runtimeAuth(
          "default-runtime-key",
          "default-profile-token",
          "https://default-runtime.example.com/v1",
          undefined,
          "x-profile-token",
        )
      : undefined,
  );

  const controller = createController({
    profileCandidates: ["default", "backup"],
  });

  await controller.initializeAuthProfile();
  expect(harness.models.runtime.baseUrl).toBe("https://default-runtime.example.com/v1");
  expect(harness.models.runtime.headers?.["x-base"]).toBe("base");
  expectProtected(harness.models.runtime.headers?.["x-profile-token"], "default-profile-token");

  await controller.advanceAuthProfile();

  expect(harness.models.runtime.baseUrl).toBe("https://old.example.com/v1");
  expect(harness.models.runtime.headers).toEqual({ "x-base": "base" });
  expect(setRuntimeApiKey).toHaveBeenLastCalledWith("custom-openai", "backup-source-key");
});

it("exhausts the remaining auth profile after a non-cooling failure", async () => {
  mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) => {
    if (profileId === "backup") {
      throw new Error("provider overloaded");
    }
    return apiKeyAuth("default-key", `profile:${String(profileId)}`, profileId);
  });
  mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
  const controller = createController({
    profileCandidates: ["default", "backup"],
  });

  await controller.initializeAuthProfile();
  await expect(controller.advanceAuthProfile()).resolves.toBe(false);
  await expect(controller.advanceAuthProfile()).resolves.toBe(false);

  expect(
    mocks.getApiKeyForModelCore.mock.calls.filter(([params]) => params.profileId === "backup"),
  ).toHaveLength(1);
  expect(harness.profileIndex).toBe(2);
});

it.each([
  ["initial candidate", ["expired", "healthy"], ["healthy", "expired"], false, false],
  ["transient initial candidate", ["expired", "healthy"], ["healthy", "expired"], false, true],
  [
    "rotated candidate",
    ["current", "expired", "healthy"],
    ["current", "healthy", "expired"],
    true,
    false,
  ],
] satisfies [string, string[], string[], boolean, boolean][])(
  "records a failed OAuth refresh for the %s and prefers the healthy profile next",
  async (_label, profileCandidates, expectedOrder, advanceAfterInitialization, retryable) => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-controller-"));
    onTestFinished(() => fs.rm(agentDir, { recursive: true, force: true }));
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        current: keyProfile("current-key"),
        expired: {
          type: "oauth",
          provider: "custom-openai",
          access: "expired-access",
          refresh: "revoked-refresh",
          expires: 0,
        },
        healthy: keyProfile("healthy-key"),
      },
      order: { "custom-openai": profileCandidates },
    };
    saveAuthProfileStore(authStore, agentDir);
    mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) => {
      if (profileId === "expired") {
        throw new OAuthRefreshFailureError({
          provider: "custom-openai",
          profileId,
          message: retryable
            ? "OAuth token refresh failed for custom-openai: 503 unavailable"
            : "OAuth token refresh failed for custom-openai: invalid_grant",
          retryable,
        });
      }
      return profileAuth(profileId);
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
    const warn = vi.fn<(message: string) => void>();
    const controller = createController({
      profileCandidates,
      authStore,
      agentDir,
      log: { debug() {}, info() {}, warn },
    });

    await controller.initializeAuthProfile();
    if (advanceAfterInitialization) {
      await expect(controller.advanceAuthProfile()).resolves.toBe(true);
    }

    expect(harness.lastProfileId).toBe("healthy");
    const persistedStore = ensureAuthProfileStore(agentDir, { syncExternalCli: false });
    if (retryable) {
      expect(persistedStore.usageStats?.expired).toMatchObject({
        cooldownReason: "timeout",
        failureCounts: { timeout: 1 },
      });
      expect(persistedStore.usageStats?.expired?.disabledUntil).toBeUndefined();
      expect(persistedStore.usageStats?.expired?.cooldownUntil).toBeGreaterThan(Date.now());
      expect(persistedStore.usageStats?.expired?.cooldownUntil).toBeLessThanOrEqual(
        Date.now() + 30_000,
      );
    } else {
      expect(persistedStore.usageStats?.expired).toMatchObject({
        disabledReason: "auth_permanent",
        failureCounts: { auth_permanent: 1 },
      });
      expect(persistedStore.usageStats?.expired?.disabledUntil).toBeGreaterThan(Date.now());
    }
    expect(
      resolveAuthProfileOrder({
        store: persistedStore,
        provider: "custom-openai",
        forModel: "test-model",
      }),
    ).toEqual(expectedOrder);
    expect(warn).toHaveBeenCalledWith(
      retryable
        ? 'auth profile "expired" failed for provider "custom-openai": OAuth token refresh failed for custom-openai: 503 unavailable'
        : 'auth profile "expired" failed for provider "custom-openai": OAuth token refresh failed for custom-openai: invalid_grant',
    );
  },
);

it("keeps credentials opaque until the runtime auth exchange boundary", async () => {
  const secret = "runtime-exchange-source-secret";
  const sentinel = mintSecretSentinel(secret, { label: "model-auth:custom-openai" });
  mocks.getApiKeyForModelCore.mockResolvedValue(
    apiKeyAuth(sentinel, "profile:custom-openai:default"),
  );
  mocks.prepareProviderRuntimeAuth.mockResolvedValue(
    runtimeAuth("runtime-exchange-token", "runtime-header-token"),
  );
  const controller = createController();
  await controller.initializeAuthProfile();

  expect(mocks.getApiKeyForModelCore).toHaveBeenCalledWith(
    expect.objectContaining({ secretSentinels: true }),
  );
  expect(mocks.prepareProviderRuntimeAuth.mock.calls[0]?.[0]?.context.apiKey).toBe(sentinel);
  expectProtected(setRuntimeApiKey.mock.calls[0]?.[1], "runtime-exchange-token");
  expectProtected(harness.models.runtime.headers?.["api-key"], "runtime-header-token");
});

it("preserves an empty runtime-auth result for fallback validation", async () => {
  const sentinel = mintSecretSentinel("runtime-source-secret", {
    label: "model-auth:custom-openai",
  });
  mocks.getApiKeyForModelCore.mockResolvedValue(
    apiKeyAuth(sentinel, "profile:custom-openai:default"),
  );
  mocks.prepareProviderRuntimeAuth.mockResolvedValue({ apiKey: "" });

  const controller = createController();
  await controller.initializeAuthProfile();

  expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", sentinel);
});

it("registers exchanged credentials when sentinels are disabled", async () => {
  vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "off");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const source = mintSecretSentinel("kill-switch-source-secret", {
    label: "model-auth:custom-openai",
  });
  mocks.getApiKeyForModelCore.mockResolvedValue(
    apiKeyAuth(source, "profile:custom-openai:default"),
  );
  mocks.prepareProviderRuntimeAuth.mockResolvedValue({ apiKey: "kill-switch-runtime-token" });

  const controller = createController();
  await controller.initializeAuthProfile();
  expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "kill-switch-runtime-token");
  expect(isSecretValueRegisteredForRedaction("kill-switch-runtime-token")).toBe(true);
});

it("includes the checked credential source when an api key is missing", async () => {
  mocks.getApiKeyForModelCore.mockResolvedValue(
    apiKeyAuth(undefined, "models.providers.custom-openai"),
  );
  const controller = createController();

  await expect(controller.initializeAuthProfile()).rejects.toThrow(
    'No API key resolved for provider "custom-openai" (auth mode: api-key, checked: models.providers.custom-openai).',
  );
  expect(setRuntimeApiKey).not.toHaveBeenCalled();
  expect(harness.apiKeyInfo).toMatchObject({
    mode: "api-key",
    source: "models.providers.custom-openai",
  });
});

it.each(["billing", "auth_permanent"] as const)(
  "preserves OAuth mode when %s-disabled profiles are all unavailable",
  async (disabledReason) => {
    const profileId = "custom-openai:oauth";
    const controller = createController({
      profileCandidates: [profileId],
      fallbackConfigured: true,
      authStore: {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "custom-openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        usageStats: {
          [profileId]: {
            disabledUntil: Date.now() + 60_000,
            disabledReason,
          },
        },
      },
    });

    const error = await controller.initializeAuthProfile().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(FailoverError);
    expect(error).toMatchObject({
      reason: disabledReason,
      authMode: "oauth",
    });
  },
);

it("preserves selected-profile identity through auth exhaustion bookkeeping", async () => {
  mocks.getApiKeyForModelCore.mockRejectedValue(
    Object.assign(new Error("selected profile missing"), {
      code: "selected_auth_profile_unavailable",
    }),
  );
  const controller = createController({
    profileCandidates: ["first", "second"],
    fallbackConfigured: true,
  });

  const error = await controller.initializeAuthProfile().catch((err: unknown) => err);

  expect(error).toBeInstanceOf(FailoverError);
  expect(error).toMatchObject({
    reason: "auth",
    code: "selected_auth_profile_unavailable",
    status: undefined,
    message: "selected profile missing",
    authProfileFailure: { allInCooldown: false },
  });
  expect(mocks.getApiKeyForModelCore.mock.calls.map(([params]) => params.profileId)).toEqual([
    "first",
    "second",
  ]);
  expect(harness.profileIndex).toBe(2);
});

it("only enables transient cooldown probing when every automatic profile is transiently cooled", () => {
  const createStore = (
    usageStats: NonNullable<AuthProfileStore["usageStats"]>,
  ): AuthProfileStore => ({
    version: 1,
    profiles: {
      first: keyProfile("first-key"),
      second: keyProfile("second-key"),
    },
    usageStats,
  });
  const disabled = (disabledReason: "billing" | "rate_limit") => ({
    disabledUntil: Date.now() + 60_000,
    disabledReason,
  });
  const resolve = (
    usageStats: NonNullable<AuthProfileStore["usageStats"]>,
    lockedProfileId?: string,
  ) =>
    resolveEmbeddedAuthCooldownProbePolicy({
      authStore: createStore(usageStats),
      profileCandidates: ["first", "second"],
      lockedProfileId,
      modelId: "test-model",
      allowTransientCooldownProbe: true,
    });

  const partiallyAvailable = resolve({ first: disabled("rate_limit") });
  expect([...partiallyAvailable.probeProfileIds]).toEqual([]);
  expect(partiallyAvailable.unavailableReason).toBeNull();

  const billingDisabled = resolve({ first: disabled("billing"), second: disabled("billing") });
  expect([...billingDisabled.probeProfileIds]).toEqual([]);
  expect(billingDisabled.unavailableReason).toBe("billing");

  const rateLimited = resolve({ first: disabled("rate_limit"), second: disabled("rate_limit") });
  expect([...rateLimited.probeProfileIds]).toEqual(["first", "second"]);
  expect(rateLimited.unavailableReason).toBe("rate_limit");

  const mixedPinnedState = resolve(
    { first: disabled("billing"), second: disabled("rate_limit") },
    "first",
  );
  expect([...mixedPinnedState.probeProfileIds]).toEqual(["second"]);
  expect(mixedPinnedState.unavailableReason).toBe("rate_limit");
});

it("preserves the transient cooldown probe for a rate-limited backup after a billing-disabled pin", async () => {
  const now = Date.now();
  mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) => profileAuth(profileId));
  mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);

  const controller = createController({
    profileCandidates: ["pinned", "backup"],
    lockedProfileId: "pinned",
    allowTransientCooldownProbe: true,
    authStore: {
      version: 1,
      profiles: {
        pinned: keyProfile("pinned-key"),
        backup: keyProfile("backup-key"),
      },
      usageStats: {
        pinned: { disabledUntil: now + 60_000, disabledReason: "billing" },
        backup: { blockedUntil: now + 60_000 },
      },
    },
  });

  await controller.initializeAuthProfile();

  expect(mocks.getApiKeyForModelCore).toHaveBeenCalledOnce();
  expect(mocks.getApiKeyForModelCore).toHaveBeenCalledWith(
    expect.objectContaining({ profileId: "backup" }),
  );
  expect(harness.profileIndex).toBe(1);
  expect(harness.lastProfileId).toBe("backup");
});

it("rejects privileged runtime transport overrides on the first auth exchange", async () => {
  mocks.getApiKeyForModelCore.mockResolvedValue(apiKeyAuth("source-api-key", "env", "default"));
  mocks.prepareProviderRuntimeAuth.mockResolvedValue({
    apiKey: "runtime-api-key",
    request: {
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.internal:8443",
      },
    },
  });

  const controller = createController();

  await expect(controller.initializeAuthProfile()).rejects.toThrow(
    /runtime auth request overrides do not allow proxy or tls/i,
  );
});

it("ignores stale scheduled refresh results after auth profile rotation", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const staleRefresh = createDeferred<ReturnType<typeof runtimeAuth>>();
  mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) => {
    const selected = profileId === "backup" ? "backup" : "default";
    return apiKeyAuth(`${selected}-source-api-key`, "env", selected);
  });
  mocks.prepareProviderRuntimeAuth.mockImplementation(async ({ context }) => {
    if (context.apiKey === "default-source-api-key" && context.profileId === "default") {
      if (harness.runtimeAuthState?.refreshInFlight) {
        return staleRefresh.promise;
      }
      return runtimeAuth(
        "default-runtime-api-key",
        "default-runtime-header-token",
        "https://default-runtime.example.com/v1",
        Date.now() + 60_000,
      );
    }
    if (context.apiKey === "backup-source-api-key" && context.profileId === "backup") {
      return runtimeAuth(
        "backup-runtime-api-key",
        "backup-runtime-header-token",
        "https://backup-runtime.example.com/v1",
        Date.now() + 120_000,
      );
    }
    throw new Error(`Unexpected runtime auth request for ${String(context.profileId)}`);
  });

  const controller = createController({
    profileCandidates: ["default", "backup"],
  });

  await controller.initializeAuthProfile();
  expect(harness.runtimeAuthState?.profileId).toBe("default");
  expectProtected(harness.runtimeAuthState?.apiKey, "default-runtime-api-key");

  vi.advanceTimersByTime(5_000);
  await Promise.resolve();
  const refreshInFlight = harness.runtimeAuthState?.refreshInFlight;
  expect(typeof refreshInFlight?.then).toBe("function");

  await controller.advanceAuthProfile();
  expect(harness.runtimeAuthState?.profileId).toBe("backup");
  expectProtected(harness.runtimeAuthState?.apiKey, "backup-runtime-api-key");
  expect(harness.models.runtime.baseUrl).toBe("https://backup-runtime.example.com/v1");
  const backupHeader = harness.models.runtime.headers?.["api-key"];
  expectProtected(backupHeader, "backup-runtime-header-token");

  staleRefresh.resolve(
    runtimeAuth(
      "default-runtime-api-key-refreshed",
      "default-refresh-header-token",
      "https://default-refresh.example.com/v1",
      Date.now() + 30_000,
    ),
  );
  await Promise.resolve();
  await Promise.resolve();

  expect(harness.runtimeAuthState?.profileId).toBe("backup");
  expect(harness.models.runtime.baseUrl).toBe("https://backup-runtime.example.com/v1");
  expect(harness.models.runtime.headers?.["api-key"]).toBe(backupHeader);
  expectProtected(harness.runtimeAuthState?.apiKey, "backup-runtime-api-key");
  expectProtected(setRuntimeApiKey.mock.calls.at(-1)?.[1], "backup-runtime-api-key");
  controller.stopRuntimeAuthRefreshTimer();
});

it.each([false, true, "provider-abort"])(
  "injects the AWS SDK sentinel and clears stale refresh state (exchange throws: %s)",
  async (exchangeThrows) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const warn = vi.fn<(message: string) => void>();
    if (!exchangeThrows) {
      harness.runtimeAuthState = {
        sourceApiKey: "__aws_sdk_auth__",
        apiKey: "__aws_sdk_auth__",
        authMode: "aws-sdk",
        refreshTimer: setTimeout(() => undefined, 60_000),
      };
    }
    mocks.getApiKeyForModelCore.mockResolvedValue({
      apiKey: undefined,
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });
    if (exchangeThrows) {
      const error = new Error("No runtime auth plugin");
      if (exchangeThrows === "provider-abort") {
        error.name = "AbortError";
      }
      mocks.prepareProviderRuntimeAuth.mockRejectedValue(error);
    } else {
      mocks.prepareProviderRuntimeAuth.mockResolvedValue(null);
    }
    const controller = createController({
      profileCandidates: [undefined],
      log: { debug() {}, info() {}, warn },
    });
    await controller.initializeAuthProfile();
    expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "__aws_sdk_auth__");
    expect(harness.runtimeAuthState).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    if (exchangeThrows) {
      expect(warn).toHaveBeenCalledWith(
        "prepareProviderRuntimeAuth failed for custom-openai, falling back to sentinel: No runtime auth plugin",
      );
    }
  },
);

it.each([
  { authProfileStateMode: "read-only" as const },
  { authProfileFailurePolicy: "local" as const },
  { authProfileStateMode: "read-write" as const },
])("keeps refresh health writes at the caller policy boundary: %j", async (policy) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-policy-"));
  const agentDir = path.join(stateDir, "agents/main/agent");
  await fs.mkdir(agentDir, { recursive: true });
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: agentDir }, async () => {
    const profileId = "expired";
    const credential = {
      type: "oauth" as const,
      provider: "custom-openai",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() - 60_000,
    };
    const authStore: AuthProfileStore = { version: 1, profiles: { [profileId]: credential } };
    saveAuthProfileStore(authStore, agentDir, { filterExternalAuthProfiles: false });
    mockOAuthProviderOperations({
      // Only provider-owned evidence restores the claimed grant; the caller policy owns health writes.
      refreshCredential: async () => {
        throw createOAuthRefreshError("token endpoint unavailable", {
          version: 1,
          phase: "token-response",
          outcome: "unchanged",
          status: 503,
          recovery: { kind: "later", evidence: "documented-reusable-grant" },
        });
      },
    });
    const manager = createOAuthManager();
    mocks.getApiKeyForModelCore.mockImplementation(async () =>
      manager.resolveOAuthAccess({ store: authStore, profileId, credential, agentDir }),
    );
    const controller = createController({
      agentDir,
      workspaceDir: stateDir,
      authStore,
      profileCandidates: [profileId],
      fallbackConfigured: true,
      ...policy,
    });
    try {
      await expect(controller.initializeAuthProfile()).rejects.toThrow();
      const persisted = loadPersistedAuthProfileStore(agentDir)!;
      expect(persisted.profiles[profileId]).toEqual(credential);
      if (policy.authProfileStateMode === "read-write") {
        expect(persisted.usageStats?.[profileId]?.failureCounts).toEqual({ timeout: 1 });
      } else {
        expect(persisted.usageStats?.[profileId]).toBeUndefined();
      }
    } finally {
      vi.restoreAllMocks();
      await cleanupSessionStateForTest({ stateDir });
      closeOpenClawStateDatabaseForTest();
    }
  });
  await fs.rm(stateDir, { recursive: true, force: true });
});
