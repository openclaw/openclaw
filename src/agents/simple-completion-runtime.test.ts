// Simple completion runtime tests cover model resolution, provider auth, and
// one-shot completion wiring before requests reach the shared LLM stream path.
import { createApiRegistry } from "@openclaw/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

// Hoisted mocks keep Vitest module replacement stable while the implementation
// under test imports auth, model resolution, and transport helpers at module load.
const hoisted = vi.hoisted(() => ({
  acquireRuntimeLeaseMock: vi.fn(),
  resolveModelMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  applyLocalNoAuthHeaderOverrideMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
  prepareProviderRuntimeAuthMock: vi.fn(),
  ensureAuthProfileStoreMock: vi.fn(),
  getCurrentPluginMetadataSnapshotMock:
    vi.fn<
      typeof import("../plugins/current-plugin-metadata-snapshot.js").getCurrentPluginMetadataSnapshot
    >(),
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: hoisted.acquireRuntimeLeaseMock,
}));

vi.mock("../plugins/runtime/generation-scope.js", () => ({
  getPluginRuntimeGenerationRegistry: () => undefined,
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
  resolveModel: hoisted.resolveModelMock,
  resolveModelAsync: hoisted.resolveModelAsyncMock,
}));

vi.mock("./auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: hoisted.ensureAuthProfileStoreMock,
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: hoisted.getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  formatMissingAuthError: vi.fn(
    (auth: { source: string; mode: string }, provider: string) =>
      `No API key resolved for provider "${provider}" (auth mode: ${auth.mode}, checked: ${auth.source}).`,
  ),
  getApiKeyForModelCore: hoisted.getApiKeyForModelMock,
  resolveApiKeyForProviderCore: hoisted.getApiKeyForModelMock,
  applyLocalNoAuthHeaderOverride: hoisted.applyLocalNoAuthHeaderOverrideMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuthMock,
}));

import {
  prepareSimpleCompletionModel,
  acquireSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

let preparedModelRuntime: PreparedModelRuntimeSnapshot;

beforeEach(() => {
  hoisted.acquireRuntimeLeaseMock.mockReset();
  hoisted.resolveModelMock.mockReset();
  hoisted.resolveModelAsyncMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.applyLocalNoAuthHeaderOverrideMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.prepareProviderRuntimeAuthMock.mockReset();
  hoisted.ensureAuthProfileStoreMock.mockReset();
  hoisted.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
  hoisted.getCurrentPluginMetadataSnapshotMock.mockReset();
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
    inlineProviderModels: [],
    activeProjectKeys: [],
    createStores: () => ({ authStorage, modelRegistry }),
  };
  hoisted.acquireRuntimeLeaseMock.mockResolvedValue({
    snapshot: preparedModelRuntime,
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  });

  hoisted.applyLocalNoAuthHeaderOverrideMock.mockImplementation((model: unknown) => model);

  hoisted.resolveModelMock.mockReturnValue({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
      api: "anthropic-messages",
    },
    authStorage: {
      setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
    },
    modelRegistry: {},
  });
  hoisted.resolveModelAsyncMock.mockImplementation((...args: unknown[]) =>
    Promise.resolve(hoisted.resolveModelMock(...args)),
  );
  hoisted.getApiKeyForModelMock.mockResolvedValue({
    apiKey: "sk-test",
    source: "env:TEST_API_KEY",
    mode: "api-key",
  });
  hoisted.prepareProviderRuntimeAuthMock.mockImplementation(
    async (params: { provider: string }) => {
      return params.provider === "github-copilot"
        ? {
            apiKey: "copilot-runtime-token",
            baseUrl: "https://api.individual.githubcopilot.com",
          }
        : undefined;
    },
  );
  hoisted.getCurrentPluginMetadataSnapshotMock.mockReturnValue(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "openai",
          modelCatalog: {
            providers: {
              openai: {
                defaultUtilityModel: "gpt-5.5",
                models: [{ id: "gpt-5.5" }],
              },
            },
          },
        },
      ],
    }),
  );
});

function expectPreparedModelResult(
  result: Awaited<ReturnType<typeof prepareSimpleCompletionModel>>,
): asserts result is Exclude<typeof result, { error: string }> {
  expect(result).not.toHaveProperty("error");
  if ("error" in result) {
    throw new Error(result.error);
  }
}

function callArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0];
}

function createOpenAIRouteModelResolver(params: {
  api: "openai-responses" | "openai-chatgpt-responses";
  baseUrl: string;
}) {
  return vi.fn<SimpleCompletionModelResolver>(
    async (provider, modelId, _agentDir, cfg, options) => {
      if (!options?.authStorage || !options.modelRegistry) {
        throw new Error("Prepared model stores were not bound");
      }
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
  it("resolves model auth and sets runtime api key", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: " sk-test ",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/runtime-workspace",
      modelResolver: hoisted.resolveModelAsyncMock as SimpleCompletionModelResolver,
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("anthropic");
    expect(result.model.id).toBe("claude-opus-4-6");
    expect(result.auth.mode).toBe("api-key");
    expect(result.auth.source).toBe("env:TEST_API_KEY");
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-test");
    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      workspaceDir: "/tmp/runtime-workspace",
    });
  });

  it("captures the exact locked auth owner used by a bound completion", async () => {
    const credential = {
      type: "api_key" as const,
      provider: "anthropic",
      key: "sk-p2",
    };
    const store = { version: 1, profiles: { "anthropic:p2": credential } };
    hoisted.ensureAuthProfileStoreMock.mockReturnValueOnce(store);
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "sk-p2",
      profileId: "anthropic:p2",
      source: "profile:anthropic:p2",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: {},
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
      profileId: "anthropic:p2",
      bindAuthOwner: true,
    });

    expectPreparedModelResult(result);
    expect(result.sourceAuthFingerprint).toBe(
      fingerprintResolvedProviderAuth({
        apiKey: "sk-p2",
        profileId: "anthropic:p2",
        source: "profile:anthropic:p2",
        mode: "api-key",
      }),
    );
    expect(hoisted.getApiKeyForModelMock).toHaveBeenCalledWith(
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
    hoisted.ensureAuthProfileStoreMock.mockImplementation(
      (_agentDir: string, options?: { profileId?: string }) => ({
        version: 1,
        profiles: options?.profileId === profileId ? { [profileId]: credential } : {},
      }),
    );
    hoisted.getApiKeyForModelMock.mockImplementation(async () => ({
      apiKey: credential.access,
      profileId,
      source: `profile:${profileId}`,
      mode: "oauth",
    }));
    const params = {
      cfg: {},
      provider: "openai",
      modelId: "gpt-5.5",
      profileId,
      bindAuthOwner: true,
      modelResolver: createOpenAIRouteModelResolver({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      }),
    };

    const before = await prepareSimpleCompletionModel({ ...params, preparedModelRuntime });
    credential = { ...credential, access: "access-after-refresh", refresh: "refresh-after" };
    const after = await prepareSimpleCompletionModel({ ...params, preparedModelRuntime });

    expectPreparedModelResult(before);
    expectPreparedModelResult(after);
    expect(before.auth.apiKey).toBe("access-before-refresh");
    expect(after.auth.apiKey).toBe("access-after-refresh");
    expect(before.sourceAuthFingerprint).toBe(after.sourceAuthFingerprint);
    expect(after.sourceAuthFingerprint).toBe(
      fingerprintAuthProfileCredential({ profileId, credential }),
    );
  });

  it("returns error when model resolution fails", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      error: "Unknown model: anthropic/missing-model",
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "anthropic",
      modelId: "missing-model",
    });

    expect(result).toEqual({
      error: "Unknown model: anthropic/missing-model",
    });
    expect(hoisted.getApiKeyForModelMock).not.toHaveBeenCalled();
  });

  it("returns error when api key is missing and mode is not allowlisted", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "models.providers.anthropic",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error:
        'No API key resolved for provider "anthropic" (auth mode: api-key, checked: models.providers.anthropic).',
      auth: {
        source: "models.providers.anthropic",
        mode: "api-key",
      },
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("continues without api key when auth mode is allowlisted", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock",
        id: "anthropic.claude-sonnet-4-6",
        api: "bedrock-converse-stream",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
      allowMissingApiKeyModes: ["aws-sdk"],
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("amazon-bedrock");
    expect(result.model.id).toBe("anthropic.claude-sonnet-4-6");
    expect(result.auth).toEqual({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("exchanges github token when provider is github-copilot", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      provider: "github-copilot",
      context: {
        apiKey: "ghu_test",
        authMode: "token",
        modelId: "gpt-4.1",
      },
    });
    const [storedProvider, storedKey] = hoisted.setRuntimeApiKeyMock.mock.calls[0] as [
      string,
      string,
    ];
    expect(storedProvider).toBe("github-copilot");
    expect(looksLikeSecretSentinel(storedKey)).toBe(true);
    expect(storedKey).not.toBe("copilot-runtime-token");
    expect(resolveSecretSentinel(storedKey)).toBe("copilot-runtime-token");
  });

  it("returns exchanged copilot token in auth.apiKey for github-copilot provider", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_original_github_token",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }

    // Callers must only receive the short-lived Copilot runtime token. The
    // original GitHub token is broader auth material and must not leave prep.
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("copilot-runtime-token");
    expect(result.auth.apiKey).not.toBe("ghu_original_github_token");
  });

  it("keeps an exchanged Copilot token opaque when its source is a sentinel", async () => {
    const sourceSecret = "github-source-secret";
    const sourceSentinel = mintSecretSentinel(sourceSecret, {
      label: "model-auth:github-copilot",
    });
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: { provider: "github-copilot", id: "gpt-4.1", api: "openai-completions" },
      authStorage: { setRuntimeApiKey: hoisted.setRuntimeApiKeyMock },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: sourceSentinel,
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      provider: "github-copilot",
      context: { apiKey: sourceSentinel },
    });
    expectPreparedModelResult(result);
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("copilot-runtime-token");
  });

  it("applies exchanged copilot baseUrl to returned model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "copilot-runtime-token",
      baseUrl: "https://api.copilot.enterprise.example",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.model.baseUrl).toBe("https://api.copilot.enterprise.example");
  });

  it("returns error when getApiKeyForModelCore throws", async () => {
    hoisted.getApiKeyForModelMock.mockRejectedValueOnce(new Error("Profile not found: copilot"));

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error: 'Auth lookup failed for provider "anthropic": Profile not found: copilot',
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("applies local no-auth header override before returning model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "local-openai",
        id: "chat-local",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "custom-local",
      source: "models.providers.local-openai (synthetic local key)",
      mode: "api-key",
    });
    hoisted.applyLocalNoAuthHeaderOverrideMock.mockReturnValueOnce({
      provider: "local-openai",
      id: "chat-local",
      api: "openai-completions",
      headers: { Authorization: null },
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "local-openai",
      modelId: "chat-local",
    });

    const overrideCall = hoisted.applyLocalNoAuthHeaderOverrideMock.mock.calls.at(0);
    expect((overrideCall?.[0] as { provider?: string; id?: string } | undefined)?.provider).toBe(
      "local-openai",
    );
    expect((overrideCall?.[0] as { provider?: string; id?: string } | undefined)?.id).toBe(
      "chat-local",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.apiKey).toBe(
      "custom-local",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.source).toBe(
      "models.providers.local-openai (synthetic local key)",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.mode).toBe(
      "api-key",
    );
    expectPreparedModelResult(result);
    expect(result.model.headers?.Authorization).toBeNull();
  });

  it("applies provider runtime auth before storing simple-completion credentials", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock-mantle",
        id: "anthropic.claude-opus-4-7",
        api: "anthropic-messages",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "__amazon_bedrock_mantle_iam__",
      source: "models.providers.amazon-bedrock-mantle.apiKey",
      mode: "api-key",
      profileId: "mantle",
    });
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "bedrock-runtime-token",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "amazon-bedrock-mantle",
      modelId: "anthropic.claude-opus-4-7",
      agentDir: "/tmp/openclaw-agent",
    });

    const runtimeAuthInput = callArg(hoisted.prepareProviderRuntimeAuthMock) as {
      provider?: string;
      workspaceDir?: string;
      context?: {
        apiKey?: string;
        authMode?: string;
        modelId?: string;
        profileId?: string;
      };
    };
    expect(runtimeAuthInput.provider).toBe("amazon-bedrock-mantle");
    expect(runtimeAuthInput.workspaceDir).toBe("/tmp/runtime-workspace");
    expect(runtimeAuthInput.context?.apiKey).toBe("__amazon_bedrock_mantle_iam__");
    expect(runtimeAuthInput.context?.authMode).toBe("api-key");
    expect(runtimeAuthInput.context?.modelId).toBe("anthropic.claude-opus-4-7");
    expect(runtimeAuthInput.context?.profileId).toBe("mantle");
    const [storedProvider, storedKey] = hoisted.setRuntimeApiKeyMock.mock.calls[0] as [
      string,
      string,
    ];
    expect(storedProvider).toBe("amazon-bedrock-mantle");
    expect(looksLikeSecretSentinel(storedKey)).toBe(true);
    expect(storedKey).not.toBe("bedrock-runtime-token");
    expect(resolveSecretSentinel(storedKey)).toBe("bedrock-runtime-token");
    expectPreparedModelResult(result);
    expect(result.model.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("bedrock-runtime-token");
  });

  it("can skip agent model/auth discovery for config-scoped one-shot completions", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "ollama",
        id: "llama3.2:latest",
        api: "ollama",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ollama-local",
      source: "models.json (local marker)",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "ollama",
      modelId: "llama3.2:latest",
      skipAgentDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "ollama",
      "llama3.2:latest",
      "/tmp/openclaw-agent",
      undefined,
      expect.objectContaining({
        skipAgentDiscovery: true,
        workspaceDir: "/tmp/runtime-workspace",
        preparedModelRuntime: expect.anything(),
      }),
    );
  });

  it("uses asynchronous provider model discovery", async () => {
    // Use a standalone mock so the default beforeEach delegation from
    // resolveModelAsyncMock → resolveModelMock does not pollute call
    // history. Only the async resolver should be invoked.
    const resolveModelAsync = vi.fn().mockResolvedValue({
      model: {
        provider: "anthropic",
        id: "claude-opus-4-6",
        api: "anthropic-messages",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    // Reset the hoisted sync mock so any leftover calls from earlier tests
    // or beforeEach setup don't cause a false positive.
    hoisted.resolveModelMock.mockReset();

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelResolver: resolveModelAsync,
    });

    expectPreparedModelResult(result);
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "anthropic",
      "claude-opus-4-6",
      "/tmp/openclaw-agent",
      undefined,
      expect.objectContaining({
        workspaceDir: "/tmp/runtime-workspace",
        preparedModelRuntime: expect.anything(),
      }),
    );
  });

  it("passes static catalog fallback opt-in to skip-discovery model resolution", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "mistral",
        id: "mistral-medium-3-5",
        api: "mistral-conversations",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: undefined,
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      allowBundledStaticCatalogFallback: true,
      skipAgentDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "mistral",
      "mistral-medium-3-5",
      "/tmp/openclaw-agent",
      undefined,
      expect.objectContaining({
        allowBundledStaticCatalogFallback: true,
        skipAgentDiscovery: true,
        workspaceDir: "/tmp/runtime-workspace",
        preparedModelRuntime: expect.anything(),
      }),
    );
  });
});

describe("acquireSimpleCompletionModelForAgent", () => {
  it("materializes a derived utility model on the Platform route for API-key auth", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:platform": { type: "api_key", provider: "openai", key: "placeholder" },
      },
    });
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
    const modelResolver = createOpenAIRouteModelResolver({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "placeholder",
      profileId: "openai:platform",
      source: "profile:openai:platform",
      mode: "api-key",
    });

    const result = await acquireSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      useUtilityModel: true,
      skipAgentDiscovery: true,
      modelResolver,
    });

    try {
      expectPreparedModelResult(result);
      expect(result.selection.provider).toBe("openai");
      expect(result.selection.modelId).toBe("gpt-5.5");
      expect(result.model).toMatchObject({
        id: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      expect(modelResolver).toHaveBeenCalledTimes(2);
      expect(
        (callArg(hoisted.getApiKeyForModelMock, 0) as { model?: { api?: string } }).model?.api,
      ).toBe("openai-responses");
      // Route materialization re-resolves the model on a multi-agent config; both
      // calls must keep the authorized agentId or the second falls back to
      // resolveDefaultAgentId, which throws on a multi-agent config.
      expect(modelResolver.mock.calls[0]?.[4]).toMatchObject({ agentId: "main" });
      expect(modelResolver.mock.calls[1]?.[4]).toMatchObject({ agentId: "main" });
    } finally {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    }
  });

  it.each(["mixed credentials", "same-route fallback", "pinned profile"])(
    "preserves subscription selection with %s",
    async (scenario) => {
      const authLookup = hoisted.getApiKeyForModelMock;
      const mixed = scenario === "mixed credentials";
      const pinned = scenario === "pinned profile";
      const oauth = {
        type: "oauth",
        provider: "openai",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 60_000,
      };
      hoisted.ensureAuthProfileStoreMock.mockReturnValue({
        version: 1,
        profiles: {
          "openai:ready": oauth,
          ...((mixed || pinned) && {
            "openai:platform": { type: "api_key", provider: "openai", key: "placeholder" },
          }),
          ...(!mixed && { "openai:expired": { ...oauth, expires: Date.now() - 60_000 } }),
        },
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        ...(!mixed && !pinned
          ? { auth: { order: { openai: ["openai:expired", "openai:ready"] } } }
          : {}),
      };
      authLookup.mockImplementation(({ profileId }: { profileId?: string }) => {
        if (profileId === "openai:expired") {
          const failure = { provider: "openai", message: "Fixture refresh rejected" };
          throw pinned ? new Error(failure.message) : new OAuthRefreshFailureError(failure);
        }
        return {
          apiKey: "fixture-access",
          profileId: profileId ?? "openai:platform",
          source: `profile:${profileId ?? "openai:platform"}`,
          mode: profileId === "openai:ready" ? "oauth" : "api-key",
        };
      });
      const modelResolver = createOpenAIRouteModelResolver({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      });
      const result = await acquireSimpleCompletionModelForAgent({
        cfg,
        agentId: "main",
        modelRef: `openai/gpt-5.5${pinned ? "@openai:expired" : ""}`,
        bindAuthOwner: pinned,
        skipAgentDiscovery: true,
        modelResolver,
      });
      try {
        if (pinned) {
          expect(result).toMatchObject({
            error: expect.stringContaining("Fixture refresh rejected"),
          });
        } else {
          expectPreparedModelResult(result);
          expect(result.selection.modelId).toBe("gpt-5.5");
          expect(result.auth.profileId).toBe("openai:ready");
          expect(result.model).toMatchObject({
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          });
        }
        expect(authLookup).toHaveBeenCalledTimes(mixed || pinned ? 1 : 2);
        expect(authLookup).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ profileId: mixed ? "openai:ready" : "openai:expired" }),
        );
        if (!mixed && !pinned) {
          expect(authLookup).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ profileId: "openai:ready" }),
          );
        }
      } finally {
        if (!("error" in result)) {
          await result[Symbol.asyncDispose]();
        }
      }
    },
  );

  it("keeps an authored custom OpenAI route untouched", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "fixture-api-key",
            baseUrl: "https://relay.example/v1",
            models: [{ id: "gpt-5.5" }],
          },
        },
      },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } as unknown as OpenClawConfig;
    const modelResolver = createOpenAIRouteModelResolver({
      api: "openai-responses",
      baseUrl: "https://relay.example/v1",
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "placeholder",
      source: "models.providers.openai",
      mode: "api-key",
    });

    const result = await acquireSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      skipAgentDiscovery: true,
      modelResolver,
    });

    try {
      expectPreparedModelResult(result);
      expect(result.model).toMatchObject({
        api: "openai-responses",
        baseUrl: "https://relay.example/v1",
      });
      expect(modelResolver).toHaveBeenCalledTimes(1);
    } finally {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    }
  });

  it("honors an explicit model ref while selecting its auth-compatible route", async () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1", models: [], apiKey: "placeholder" },
        },
      },
    } as unknown as OpenClawConfig;
    const modelResolver = createOpenAIRouteModelResolver({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "placeholder",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });

    const result = await acquireSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      modelRef: "openai/gpt-5.5",
      skipAgentDiscovery: true,
      modelResolver,
    });

    try {
      expectPreparedModelResult(result);
      expect(result.selection).toMatchObject({ provider: "openai", modelId: "gpt-5.5" });
      expect(result.model).toMatchObject({ id: "gpt-5.5", api: "openai-responses" });
    } finally {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    }
  });
});
