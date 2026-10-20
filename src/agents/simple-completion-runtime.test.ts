import { createApiRegistry } from "@openclaw/ai";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../secrets/sentinel.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import * as authProfileRecords from "./auth-profiles/profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import type { ResolvedProviderAuth } from "./model-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import { completeWithAuthProfileFailover } from "./simple-completion-profile-failover.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const m = vi.hoisted(() => ({
  acquireLease: vi.fn(),
  resolveModel: vi.fn(),
  resolveModelAsync: vi.fn(),
  getAuth: vi.fn(),
  localAuth: vi.fn(),
  storeKey: vi.fn(),
  runtimeAuth: vi.fn(),
  authStore: vi.fn(),
  markFailure: vi.fn<typeof import("./auth-profiles/usage.js").markAuthProfileFailure>(),
  markSuccess: vi.fn<typeof import("./auth-profiles/profiles.js").markAuthProfileSuccess>(),
  metadata:
    vi.fn<
      typeof import("../plugins/current-plugin-metadata-snapshot.js").getCurrentPluginMetadataSnapshot
    >(),
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: m.acquireLease,
}));

// mock-isolation: preparation runs without a published plugin generation.
vi.mock("../plugins/runtime/generation-scope.js", () => ({
  getPluginRuntimeGenerationRegistry: () => undefined,
  runOutsidePluginRuntimeGenerationScope: (run: () => unknown) => run(),
  withPluginRuntimeGenerationScope: (_snapshot: unknown, run: () => unknown) => run(),
}));

vi.mock("./sessions/model-registry-runtime.js", () => ({
  initializeModelRegistryRuntime: vi.fn(),
  getModelRegistryRuntime: () => {
    const apiRegistry = createApiRegistry();
    return {
      apiRegistry,
      llmRuntime: {
        registry: apiRegistry,
        completeSimple: vi.fn(),
        streamSimple: vi.fn(),
      },
    };
  },
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModel: m.resolveModel,
  resolveModelAsync: m.resolveModelAsync,
}));

// mock-isolation: Completion credential binding uses the fixture store without loading host profiles.
vi.mock("./auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: m.authStore,
  ensureAuthProfileStoreAsync: m.authStore,
}));

// mock-isolation: Keep quota probes and credential-health writes out of the model-preparation fixture.
vi.mock("./auth-profiles/usage.js", () => ({
  reconcileAuthProfileQuotaBlocks: vi.fn(async () => {}),
  markAuthProfileFailure: m.markFailure,
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: m.metadata,
}));

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  formatMissingAuthError: vi.fn(
    (auth: { source: string; mode: string }, provider: string) =>
      `No API key resolved for provider "${provider}" (auth mode: ${auth.mode}, checked: ${auth.source}).`,
  ),
  getApiKeyForModelCore: m.getAuth,
  resolveApiKeyForProviderCore: m.getAuth,
  applyLocalNoAuthHeaderOverride: m.localAuth,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: m.runtimeAuth,
}));

import {
  prepareSimpleCompletionModel,
  acquireSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

let preparedModelRuntime: PreparedModelRuntimeSnapshot;
const subscriptionRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as const;
const platformRoute = { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } as const;
const customRoute = { api: "openai-responses", baseUrl: "https://relay.example/v1" } as const;
const openaiDefaults = { model: "openai/gpt-5.5" };
function profileAuth(
  profileId: string,
  apiKey: string,
  mode: ResolvedProviderAuth["mode"] = "api-key",
): ResolvedProviderAuth {
  return { apiKey, profileId, source: `profile:${profileId}`, mode };
}
function apiProfile(key: string, provider = "openai") {
  return { type: "api_key" as const, provider, key };
}
function setProfiles(profiles: AuthProfileStore["profiles"]) {
  const store: AuthProfileStore = { version: 1, profiles };
  m.authStore.mockReturnValue(store);
  return store;
}

function resolvedModel(model: Pick<Model, "provider" | "id" | "api"> & Partial<Model>) {
  return {
    model,
    authStorage: { setRuntimeApiKey: m.storeKey },
    modelRegistry: {},
  };
}
function mockModel(provider: string, id: string, api: Model["api"], baseUrl?: string) {
  m.resolveModel.mockReturnValueOnce(
    resolvedModel({ provider, id, api, ...(baseUrl ? { baseUrl } : {}) }),
  );
}
function prepare(overrides: Partial<Parameters<typeof prepareSimpleCompletionModel>[0]> = {}) {
  return prepareSimpleCompletionModel({
    preparedModelRuntime,
    cfg: undefined,
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    ...overrides,
  });
}
async function acquire(params: Parameters<typeof acquireSimpleCompletionModelForAgent>[0]) {
  const result = await acquireSimpleCompletionModelForAgent({
    agentId: "main",
    skipAgentDiscovery: true,
    ...params,
  });
  return {
    result,
    async [Symbol.asyncDispose]() {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(m)) {
    mock.mockReset();
  }
  m.authStore.mockReturnValue({ version: 1, profiles: {} });
  m.markFailure.mockResolvedValue(undefined);
  m.markSuccess.mockResolvedValue(undefined);
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  preparedModelRuntime = {
    catalogOwner: undefined,
    agentDir: "/tmp/openclaw-agent",
    workspaceDir: "/tmp/runtime-workspace",
    config: {},
    observationConfig: {},
    isCurrent: () => true,
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    activeProjectKeys: [],
    createStores: () => ({ authStorage, modelRegistry }),
  };
  m.acquireLease.mockResolvedValue({
    snapshot: preparedModelRuntime,
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  });

  m.localAuth.mockImplementation((model: unknown) => model);

  m.resolveModel.mockReturnValue(
    resolvedModel({
      provider: "anthropic",
      id: "claude-opus-4-6",
      api: "anthropic-messages",
    }),
  );
  m.resolveModelAsync.mockImplementation((...args: unknown[]) =>
    Promise.resolve(m.resolveModel(...args)),
  );
  m.getAuth.mockResolvedValue({
    apiKey: "sk-test",
    source: "env:TEST_API_KEY",
    mode: "api-key",
  });
  const openai = { defaultUtilityModel: "gpt-5.5", models: [{ id: "gpt-5.5" }] };
  m.metadata.mockReturnValue(
    createPluginMetadataSnapshotFixture({
      plugins: [{ id: "openai", modelCatalog: { providers: { openai } } }],
    }),
  );
});

function assertPrepared<T extends Awaited<ReturnType<typeof prepareSimpleCompletionModel>>>(
  result: T,
): asserts result is Exclude<T, { error: string }> {
  assert(!("error" in result), "Expected a prepared model");
}

function routeResolver(params: {
  api: "openai-responses" | "openai-chatgpt-responses";
  baseUrl: string;
}) {
  return vi.fn<SimpleCompletionModelResolver>(
    async (provider, modelId, _agentDir, cfg, options) => {
      assert(options?.authStorage && options.modelRegistry, "Prepared stores were not bound");
      const configured = cfg?.models?.providers?.openai;
      return {
        model: makeProviderModelFixture({
          provider,
          id: modelId,
          api: configured?.api ?? params.api,
          baseUrl: configured?.baseUrl ?? params.baseUrl,
        }),
        authStorage: options.authStorage,
        modelRegistry: options.modelRegistry,
      };
    },
  );
}

describe("prepareSimpleCompletionModel", () => {
  it("blocks helper inference under the admitted required policy with empty caller config", async () => {
    preparedModelRuntime = {
      ...preparedModelRuntime,
      config: { cloudWorkers: { requiredProfile: "required" } },
    };
    const result = await prepare({
      cfg: {},
      modelResolver: m.resolveModelAsync as SimpleCompletionModelResolver,
    });
    expect(result).toMatchObject({ error: expect.stringContaining("Sessionless model helpers") });
    expect(m.resolveModelAsync).not.toHaveBeenCalled();
    expect(m.getAuth).not.toHaveBeenCalled();
  });

  it("captures the exact locked auth owner used by a bound completion", async () => {
    const store = setProfiles({ "anthropic:p2": apiProfile("sk-p2", "anthropic") });
    const auth = profileAuth("anthropic:p2", "sk-p2");
    m.getAuth.mockResolvedValueOnce(auth);

    const result = await prepare({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      profileId: "anthropic:p2",
      bindAuthOwner: true,
    });

    assertPrepared(result);
    expect(result.sourceAuthFingerprint).toBe(fingerprintResolvedProviderAuth(auth));
    expect(m.getAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:p2",
        lockedProfile: true,
        store,
      }),
    );
  });

  it("keeps a bound personal OAuth owner stable across token rotation", async () => {
    const profileId =
      "personal:9ee1b53f-13f7-4d21-b0a1-2b539ab4fd1d:5b99e716-6cea-49f2-a79e-ffb6df8ad5e1";
    let credential = {
      type: "oauth" as const,
      provider: "openai",
      access: "access-before-refresh",
      refresh: "refresh-before",
      expires: Date.now() + 60_000,
      accountId: "workspace",
    };
    m.authStore.mockImplementation((_agentDir: string, options?: { profileId?: string }) => ({
      version: 1,
      profiles: options?.profileId === profileId ? { [profileId]: credential } : {},
    }));
    m.getAuth.mockImplementation(async () => profileAuth(profileId, credential.access, "oauth"));
    const params = {
      cfg: {},
      provider: "openai",
      modelId: "gpt-5.5",
      profileId,
      bindAuthOwner: true,
      modelResolver: routeResolver(subscriptionRoute),
    };

    const before = await prepare(params);
    credential = { ...credential, access: "access-after-refresh", refresh: "refresh-after" };
    const after = await prepare(params);

    assertPrepared(before);
    assertPrepared(after);
    expect(before.auth.apiKey).toBe("access-before-refresh");
    expect(after.auth.apiKey).toBe("access-after-refresh");
    expect(before.sourceAuthFingerprint).toBe(after.sourceAuthFingerprint);
    expect(after.sourceAuthFingerprint).toBe(
      fingerprintAuthProfileCredential({ profileId, credential }),
    );
  });

  it("returns error when model resolution fails", async () => {
    m.resolveModel.mockReturnValueOnce({
      error: "Unknown model: anthropic/missing-model",
    });

    const result = await prepare({ modelId: "missing-model" });

    expect(result).toEqual({
      error: "Unknown model: anthropic/missing-model",
    });
    expect(m.getAuth).not.toHaveBeenCalled();
  });

  it("returns error when api key is missing and mode is not allowlisted", async () => {
    const auth = { source: "models.providers.anthropic", mode: "api-key" };
    m.getAuth.mockResolvedValueOnce(auth);

    const result = await prepare();

    expect(result).toEqual({
      error:
        'No API key resolved for provider "anthropic" (auth mode: api-key, checked: models.providers.anthropic).',
      auth,
    });
    expect(m.storeKey).not.toHaveBeenCalled();
  });

  it("continues without api key when auth mode is allowlisted", async () => {
    mockModel("amazon-bedrock", "anthropic.claude-sonnet-4-6", "bedrock-converse-stream");
    const auth = { source: "aws-sdk default chain", mode: "aws-sdk" };
    m.getAuth.mockResolvedValueOnce(auth);

    const result = await prepare({
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
      allowMissingApiKeyModes: ["aws-sdk"],
    });

    assertPrepared(result);
    expect(result.model).toMatchObject({
      provider: "amazon-bedrock",
      id: "anthropic.claude-sonnet-4-6",
    });
    expect(result.auth).toEqual(auth);
    expect(m.storeKey).not.toHaveBeenCalled();
  });

  it("applies provider runtime auth before storing simple-completion credentials", async () => {
    const baseUrl = "https://bedrock-mantle.us-east-1.api.aws/anthropic";
    mockModel("amazon-bedrock-mantle", "anthropic.claude-opus-4-7", "anthropic-messages", baseUrl);
    m.getAuth.mockResolvedValueOnce({
      apiKey: "__amazon_bedrock_mantle_iam__",
      source: "models.providers.amazon-bedrock-mantle.apiKey",
      mode: "api-key",
      profileId: "mantle",
    });
    m.runtimeAuth.mockResolvedValueOnce({
      apiKey: "bedrock-runtime-token",
      baseUrl,
    });

    const result = await prepare({
      provider: "amazon-bedrock-mantle",
      modelId: "anthropic.claude-opus-4-7",
      agentDir: "/tmp/openclaw-agent",
    });

    expect(m.runtimeAuth.mock.calls[0]?.[0]).toMatchObject({
      provider: "amazon-bedrock-mantle",
      workspaceDir: "/tmp/runtime-workspace",
      context: {
        apiKey: "__amazon_bedrock_mantle_iam__",
        authMode: "api-key",
        modelId: "anthropic.claude-opus-4-7",
        profileId: "mantle",
      },
    });
    const [storedProvider, storedKey] = m.storeKey.mock.calls[0] as [string, string];
    expect(storedProvider).toBe("amazon-bedrock-mantle");
    expect(looksLikeSecretSentinel(storedKey)).toBe(true);
    expect(storedKey).not.toBe("bedrock-runtime-token");
    expect(resolveSecretSentinel(storedKey)).toBe("bedrock-runtime-token");
    assertPrepared(result);
    expect(result.model.baseUrl).toBe(baseUrl);
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("bedrock-runtime-token");
  });
});

describe("acquireSimpleCompletionModelForAgent", () => {
  it("materializes a derived utility model on the Platform route for API-key auth", async () => {
    const signal = new AbortController().signal;
    setProfiles({ "openai:platform": apiProfile("placeholder") });
    const cfg = {
      agents: {
        entries: {
          main: {},
          other: {},
        },
        defaults: {
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const modelResolver = routeResolver(subscriptionRoute);
    m.getAuth.mockResolvedValue(profileAuth("openai:platform", "placeholder"));

    await using lease = await acquire({
      cfg,
      useUtilityModel: true,
      modelResolver,
      signal,
    });
    const { result } = lease;
    assertPrepared(result);
    expect(result).toMatchObject({
      selection: { provider: "openai", modelId: "gpt-5.5" },
      model: { id: "gpt-5.5", ...platformRoute },
    });
    expect(modelResolver).toHaveBeenCalledTimes(2);
    expect(m.getAuth.mock.calls[0]?.[0]?.model?.api).toBe("openai-responses");
    // Both resolutions must preserve the admitted agent and cancellation signal.
    for (const call of modelResolver.mock.calls) {
      expect(call[4]).toMatchObject({ agentId: "main" });
      expect(call[4]?.abortSignal).toBe(signal);
    }
  });

  it.each(["mixed credentials", "same-route fallback", "pinned profile"])(
    "preserves subscription selection with %s",
    async (scenario) => {
      const authLookup = m.getAuth;
      const mixed = scenario === "mixed credentials";
      const pinned = scenario === "pinned profile";
      const oauth = {
        type: "oauth" as const,
        provider: "openai",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 60_000,
      };
      setProfiles({
        "openai:ready": oauth,
        ...((mixed || pinned) && {
          "openai:platform": apiProfile("placeholder"),
        }),
        ...(!mixed && { "openai:expired": { ...oauth, expires: Date.now() - 60_000 } }),
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: openaiDefaults },
        ...(!mixed && !pinned
          ? { auth: { order: { openai: ["openai:expired", "openai:ready"] } } }
          : {}),
      };
      authLookup.mockImplementation(({ profileId }: { profileId?: string }) => {
        if (profileId === "openai:expired") {
          const failure = { provider: "openai", message: "Fixture refresh rejected" };
          throw pinned ? new Error(failure.message) : new OAuthRefreshFailureError(failure);
        }
        return profileAuth(
          profileId ?? "openai:platform",
          "fixture-access",
          profileId === "openai:ready" ? "oauth" : "api-key",
        );
      });
      const modelResolver = routeResolver(subscriptionRoute);
      await using lease = await acquire({
        cfg,
        modelRef: `openai/gpt-5.5${pinned ? "@openai:expired" : ""}`,
        bindAuthOwner: pinned,
        modelResolver,
      });
      const { result } = lease;
      if (pinned) {
        expect(result).toMatchObject({
          error: expect.stringContaining("Fixture refresh rejected"),
        });
      } else {
        assertPrepared(result);
        expect(result).toMatchObject({
          selection: { modelId: "gpt-5.5" },
          auth: { profileId: "openai:ready" },
          model: subscriptionRoute,
        });
      }
      expect(authLookup.mock.calls.map(([args]) => args.profileId)).toEqual(
        mixed ? ["openai:ready"] : pinned ? ["openai:expired"] : ["openai:expired", "openai:ready"],
      );
    },
  );

  it("keeps an authored custom OpenAI route untouched", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            ...customRoute,
            apiKey: "fixture-api-key",
            models: [{ id: "gpt-5.5" }],
          },
        },
      },
      agents: { defaults: openaiDefaults },
    } as unknown as OpenClawConfig;
    const modelResolver = routeResolver(customRoute);
    m.getAuth.mockResolvedValue({
      apiKey: "placeholder",
      source: "models.providers.openai",
      mode: "api-key",
    });

    await using lease = await acquire({
      cfg,
      modelResolver,
    });
    const { result } = lease;
    assertPrepared(result);
    expect(result.model).toMatchObject(customRoute);
    expect(modelResolver).toHaveBeenCalledTimes(1);
  });
});

describe("acquired simple completion profile failover", () => {
  // Mock health writes; exercise real planning, classification, and advancement.
  beforeEach(() => {
    vi.spyOn(authProfileRecords, "markAuthProfileSuccess").mockImplementation(m.markSuccess);
  });
  afterEach(() => {
    vi.mocked(authProfileRecords.markAuthProfileSuccess).mockRestore();
  });

  async function acquireProfiles(pinned = false) {
    const store = setProfiles({
      "openai:p1": apiProfile("fixture-p1"),
      "openai:p2": apiProfile("fixture-p2"),
    });
    const cfg: OpenClawConfig = {
      agents: { defaults: openaiDefaults },
      auth: { order: { openai: ["openai:p1", "openai:p2"] } },
    };
    m.getAuth.mockImplementation(({ profileId }: { profileId?: string }) => {
      const credential = profileId ? store.profiles[profileId] : undefined;
      assert(profileId && credential?.type === "api_key", "Expected a configured fixture profile");
      return profileAuth(profileId, credential.key);
    });
    const prepared = await acquireSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      profileFailover: true,
      preferredProfile: "openai:p1",
      ...(pinned ? { modelRef: "openai/gpt-5.5@openai:p1", bindAuthOwner: true } : {}),
      modelResolver: routeResolver(platformRoute),
    });
    assertPrepared(prepared);
    return { cfg, store, prepared };
  }
  type FailoverParams = Parameters<typeof completeWithAuthProfileFailover>[0];
  function failover(
    prepared: FailoverParams["prepared"],
    cfg: OpenClawConfig,
    complete: FailoverParams["complete"],
    options: Partial<Pick<FailoverParams, "signal" | "assertCurrent" | "warn">> = {},
  ) {
    return completeWithAuthProfileFailover({
      cfg,
      prepared,
      complete,
      agentDir: prepared.selection.agentDir,
      assertCurrent: () => {},
      warn: vi.fn(),
      ...options,
    });
  }
  const failureMessage = (errorMessage = "429: rate limit exceeded", errorCode?: string) =>
    makeAssistantMessageFixture({ errorMessage, errorCode, content: [] });

  it.each([
    ["rate_limit", "429: rate limit exceeded", "rate_limit_exceeded"],
    ["auth", "401: invalid API key", "invalid_api_key"],
    ["billing", "402: account balance exhausted", "insufficient_quota"],
  ])(
    "rotates and records %s failures before completing on the backup",
    async (reason, errorMessage, errorCode) => {
      const fixture = await acquireProfiles();
      await using prepared = fixture.prepared;
      const failure = failureMessage(errorMessage, errorCode);
      const success = makeAssistantMessageFixture({
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "backup reply" }],
      });
      const complete = vi.fn<FailoverParams["complete"]>(async ({ auth }) =>
        auth.profileId === "openai:p1" ? failure : success,
      );

      expect(await failover(prepared, fixture.cfg, complete)).toBe(success);
      expect(complete.mock.calls.map(([{ auth }]) => auth.profileId)).toEqual([
        "openai:p1",
        "openai:p2",
      ]);
      expect(m.markFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          store: fixture.store,
          profileId: "openai:p1",
          modelId: "gpt-5.5",
          reason,
        }),
      );
      expect(m.markSuccess).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          store: fixture.store,
          profileId: "openai:p2",
          modelId: "gpt-5.5",
        }),
      );
      expect(m.acquireLease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      pinned: false,
      aborted: false,
      name: "exhausted pool despite failed bookkeeping",
      attempted: ["openai:p1", "openai:p2"],
    },
    { pinned: true, aborted: false, name: "explicitly pinned profile", attempted: ["openai:p1"] },
    { pinned: false, aborted: true, name: "aborted request", attempted: ["openai:p1"] },
  ])("returns the provider failure for an $name", async ({ pinned, aborted, attempted }) => {
    const fixture = await acquireProfiles(pinned);
    await using prepared = fixture.prepared;
    const bookkeepingFails = !pinned && !aborted;
    if (bookkeepingFails) {
      m.markFailure.mockRejectedValue(new Error("Fixture write rejected"));
    }
    const failure = failureMessage();
    const controller = new AbortController();
    const complete = vi.fn<FailoverParams["complete"]>(async () => {
      if (aborted) {
        controller.abort();
      }
      return failure;
    });
    const warn = vi.fn();

    expect(
      await failover(prepared, fixture.cfg, complete, { signal: controller.signal, warn }),
    ).toBe(failure);
    expect(complete.mock.calls.map(([{ auth }]) => auth.profileId)).toEqual(attempted);
    expect(m.markFailure.mock.calls.map(([input]) => input.profileId)).toEqual(
      aborted ? [] : attempted,
    );
    expect(m.markSuccess).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(bookkeepingFails ? 2 : 0);
  });

  it("stops before preparing a backup when authority expires during bookkeeping", async () => {
    const fixture = await acquireProfiles();
    await using prepared = fixture.prepared;
    let current = true;
    m.markFailure.mockImplementation(async () => {
      current = false;
    });
    const complete = vi.fn(async () => failureMessage());

    await expect(
      failover(prepared, fixture.cfg, complete, {
        assertCurrent: () => {
          if (!current) {
            throw new Error("Fixture completion authority expired");
          }
        },
      }),
    ).rejects.toThrow("Fixture completion authority expired");

    expect(complete).toHaveBeenCalledOnce();
    expect(m.getAuth).toHaveBeenCalledOnce();
    expect(m.markSuccess).not.toHaveBeenCalled();
  });
});
