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
import type { AuthProfileStore } from "../../auth-profiles.js";
import { OAuthRefreshFailureError } from "../../auth-profiles/oauth-refresh-failure.js";
import { resolveAuthProfileOrder } from "../../auth-profiles/order.js";
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

function runtimeAuth(apiKey: string, value: string, baseUrl?: string, expiresAt?: number) {
  return {
    apiKey,
    request: { auth: { mode: "header" as const, headerName: "api-key", value } },
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

function expectProtected(value: string | undefined, plaintext: string): void {
  expect(value).not.toBe(plaintext);
  expect(looksLikeSecretSentinel(value ?? "")).toBe(true);
  expect(resolveSecretSentinel(value ?? "")).toBe(plaintext);
}

function createController(
  params: Partial<
    Pick<
      Parameters<typeof createEmbeddedRunAuthController>[0],
      | "profileCandidates"
      | "authStore"
      | "fallbackConfigured"
      | "lockedProfileId"
      | "allowTransientCooldownProbe"
      | "agentDir"
      | "prepareModelForAuthProfile"
    >
  > & { warn?: (message: string) => void } = {},
) {
  const { warn, ...overrides } = params;
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
    ...overrides,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: warn ?? (() => undefined),
    },
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
      ? {
          apiKey: "default-runtime-key",
          baseUrl: "https://default-runtime.example.com/v1",
          request: {
            auth: {
              mode: "header" as const,
              headerName: "x-profile-token",
              value: "default-profile-token",
            },
          },
        }
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
  ["initial candidate", ["expired", "healthy"], ["healthy", "expired"], false],
  ["rotated candidate", ["current", "expired", "healthy"], ["current", "healthy", "expired"], true],
] satisfies [string, string[], string[], boolean][])(
  "records a failed OAuth refresh for the %s and prefers the healthy profile next",
  async (_label, profileCandidates, expectedOrder, advanceAfterInitialization) => {
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
          message: "OAuth token refresh failed for custom-openai: invalid_grant",
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
      warn,
    });

    await controller.initializeAuthProfile();
    if (advanceAfterInitialization) {
      await expect(controller.advanceAuthProfile()).resolves.toBe(true);
    }

    expect(harness.lastProfileId).toBe("healthy");
    const persistedStore = ensureAuthProfileStore(agentDir, { syncExternalCli: false });
    expect(persistedStore.usageStats?.expired).toMatchObject({
      disabledReason: "auth_permanent",
      failureCounts: { auth_permanent: 1 },
    });
    expect(persistedStore.usageStats?.expired?.disabledUntil).toBeGreaterThan(Date.now());
    expect(
      resolveAuthProfileOrder({
        store: persistedStore,
        provider: "custom-openai",
        forModel: "test-model",
      }),
    ).toEqual(expectedOrder);
    expect(warn).toHaveBeenCalledWith(
      'auth profile "expired" failed for provider "custom-openai": OAuth token refresh failed for custom-openai: invalid_grant',
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

it.each([false, true])(
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
      mocks.prepareProviderRuntimeAuth.mockRejectedValue(new Error("No runtime auth plugin"));
    } else {
      mocks.prepareProviderRuntimeAuth.mockResolvedValue(null);
    }
    const controller = createController({ profileCandidates: [undefined], warn });
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
