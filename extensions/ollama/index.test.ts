import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderAuthMethod, ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { LiveModelCatalogHttpError } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../test-support/model-provider-config.test-support.js";
import plugin from "./index.js";
import { createModel } from "./model.test-support.js";
import { OLLAMA_DEFAULT_API_KEY } from "./src/discovery-shared.js";
import { buildOllamaModelDefinition } from "./src/provider-models.js";

const localBaseUrl = "http://127.0.0.1:11434";
const cloudBaseUrl = "https://ollama.com";

const setupMock = vi.hoisted(() =>
  vi.fn(async () => ({
    defaultModel: "ollama/qwen-tool",
    config: ollamaConfig({
      baseUrl: localBaseUrl,
      api: "ollama",
      apiKey: "ollama-local",
      models: [{ id: "qwen-tool", name: "qwen-tool" }],
    }),
  })),
);
const pullMock = vi.hoisted(() => vi.fn(async () => {}));
const nonInteractiveMock = vi.hoisted(() => vi.fn());
const guardedFetchMock = vi.hoisted(() => vi.fn());
const modelsMock = vi.hoisted(() => vi.fn());
const loadedMock = vi.hoisted(() => vi.fn());
const discoveryMock = vi.hoisted(() => vi.fn());
const showMock = vi.hoisted(() => vi.fn());
const secretMock = vi.hoisted(() => vi.fn());
const streamMock = vi.hoisted(() =>
  vi.fn((_params: { model: unknown; providerBaseUrl?: string }) => (() => ({})) as never),
);

vi.mock("./src/provider-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/provider-models.js")>()),
  buildOllamaProvider: discoveryMock,
  fetchOllamaModels: modelsMock,
  fetchLoadedOllamaModelNames: loadedMock,
  queryOllamaModelShowInfo: showMock,
}));

vi.mock("openclaw/plugin-sdk/secret-input-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/secret-input-runtime")>();
  return {
    ...actual,
    resolveConfiguredSecretInputString: secretMock.mockImplementation(
      actual.resolveConfiguredSecretInputString,
    ),
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetchMock,
}));

vi.mock("./src/setup.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/setup.runtime.js")>()),
  configureOllamaNonInteractive: nonInteractiveMock,
  ensureOllamaModelPulled: pullMock,
  promptAndConfigureOllama: setupMock,
}));

vi.mock("./src/stream-registration.js", () => ({
  createLazyConfiguredOllamaStreamFn: streamMock,
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  for (const mock of [setupMock, pullMock, secretMock, streamMock]) {
    mock.mockClear();
  }
  guardedFetchMock.mockReset().mockResolvedValue({
    response: new Response(null, { status: 200 }),
    release: vi.fn(async () => {}),
  });
  nonInteractiveMock.mockReset();
  modelsMock.mockReset();
  loadedMock.mockReset().mockResolvedValue({
    reachable: true,
    models: ["qwen-tool", "qwen3.5:4b", "llama3.3:70b", "nomic-embed-text", "unknown-tools"],
  });
  discoveryMock.mockReset();
  showMock.mockReset().mockResolvedValue({
    contextWindow: 32_768,
    capabilities: ["completion", "tools"],
  });
});

function registerProvider(pluginConfig: Record<string, unknown> = {}) {
  return registerProviders(pluginConfig).find((provider) => provider.id === "ollama");
}

function registerProviders(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();
  plugin.register(
    createTestPluginApi({
      id: "ollama",
      pluginConfig,
      runtime: createPluginRuntimeMock(),
      registerProvider: registerProviderMock,
    }),
  );
  return registerProviderMock.mock.calls.map((call) => call[0]);
}

function registerOllamaCloudProvider() {
  return registerProviders({}).find((provider) => provider.id === "ollama-cloud");
}

describe("ollama compaction policy", () => {
  const localRoute = {
    provider: "ollama",
    id: "qwen3.5:4b",
    api: "ollama",
    baseUrl: localBaseUrl,
    expected: undefined,
  } as const;
  it.each([
    { ...localRoute, provider: "ollama-cloud" },
    { ...localRoute, id: "qwen3.5:cloud" },
    { ...localRoute, api: "openai-completions", baseUrl: `${localBaseUrl}/v1` },
    { ...localRoute, providerBaseUrl: cloudBaseUrl },
    { ...localRoute, baseUrl: cloudBaseUrl, providerBaseUrl: localBaseUrl, expected: "off" },
  ] as const)(
    "prepares compaction thinking for $provider/$id at $baseUrl ($api)",
    ({ expected, ...route }) => {
      const provider = registerProviders({}).find((entry) => entry.id === route.provider);
      const model: ProviderRuntimeModel = {
        provider: route.provider,
        api: route.api,
        baseUrl: route.baseUrl,
        ...createModel(route.id, route.id, { reasoning: true, contextWindow: 32_768 }),
        params: { think: true },
      };
      const config =
        "providerBaseUrl" in route
          ? createModelProviderConfig({
              [route.provider]: { baseUrl: route.providerBaseUrl, api: route.api, models: [] },
            })
          : {};
      const resolved =
        provider.normalizeResolvedModel?.({
          provider: route.provider,
          modelId: route.id,
          model,
          config,
        }) ?? model;
      expect(resolved.compactionThinkingDefault).toBe(expected);
      expect(resolved).toMatchObject(model);
      expect(model).not.toHaveProperty("compactionThinkingDefault");
    },
  );
});

function configuredRefs(ref: string) {
  return { agents: { defaults: { models: { [ref]: {} } } } };
}

function discoveryConfig(enabled: boolean) {
  return { plugins: { entries: { ollama: { config: { discovery: { enabled } } } } } };
}

function ollamaConfig<T extends object>(provider: T) {
  return { models: { providers: { ollama: provider } } };
}

function resetContext(
  opts: Record<string, unknown> = {},
): Parameters<NonNullable<ProviderAuthMethod["validateNonInteractive"]>>[0] {
  return {
    authChoice: "ollama",
    config: {},
    baseConfig: {},
    opts,
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as never,
    },
    resolveApiKey: vi.fn(async () => null),
  };
}

function mockDiscovery(models: Array<Record<string, unknown>>, baseUrl = localBaseUrl) {
  discoveryMock.mockResolvedValueOnce({ baseUrl, api: "ollama", models });
}

function mockShow(capabilities: string[], contextWindow = 1_048_576) {
  showMock.mockResolvedValueOnce({ contextWindow, capabilities });
}

function mockInstalledModels(models: Record<string, boolean | undefined>) {
  modelsMock.mockResolvedValue({
    reachable: true,
    models: Object.keys(models).map((name) => ({ name })),
  });
  showMock.mockImplementation(async (_baseUrl: string, modelId: string) => ({
    contextWindow: 32_768,
    capabilities: models[modelId] ? ["completion", "tools"] : ["completion"],
  }));
}

function dynamicContext(modelId: string, config: Record<string, unknown> = {}) {
  return {
    config,
    provider: "ollama",
    modelId,
    modelRegistry: { find: vi.fn(() => null) },
  };
}

async function runCatalog(
  provider: ReturnType<typeof registerProvider>,
  auth: { apiKey?: string; discoveryApiKey?: string; profileId?: string },
  config: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
) {
  return await provider.catalog.run({ config, env, resolveProviderApiKey: () => auth });
}

async function augmentCatalog(
  provider: ReturnType<typeof registerProvider>,
  overrides: Record<string, unknown> = {},
) {
  return await provider.augmentModelCatalog?.({
    config: {},
    env: process.env,
    entries: [],
    ...overrides,
  } as never);
}

describe("ollama plugin", () => {
  it.each([
    {
      name: "rejects an unreachable Ollama endpoint before destructive reset",
      reachable: false,
      models: [],
      error:
        "Ollama could not be reached at http://ollama-host:11434.\nDownload it at https://ollama.com/download",
    },
    {
      name: "rejects a missing requested Ollama model even when another model is available",
      models: ["qwen2.5-coder:7b"],
      customModelId: "gemma4",
      error:
        "Ollama model gemma4 was not found at http://ollama-host:11434.\nAvailable models: qwen2.5-coder:7b",
    },
    {
      name: "recognizes the implicit latest tag without pulling during reset preflight",
      models: ["gemma4:latest"],
      customBaseUrl: "http://ollama-host:11434/",
      customModelId: "ollama/gemma4",
    },
    {
      name: "accepts an installed completion and embedding model when the default is unavailable",
      models: ["dual-model"],
      capabilities: ["completion", "embedding"],
    },
    {
      name: "rejects an explicitly selected embedding-only model before reset",
      models: ["embedding-model"],
      customModelId: "embedding-model",
      capabilities: ["embedding"],
      omitListedCapabilities: true,
      error: "Ollama model embedding-model only supports embeddings. Choose a chat model instead.",
    },
    {
      name: "retains known embedding-only metadata when inspection is unavailable",
      models: ["embedding-model"],
      customModelId: "embedding-model",
      capabilities: ["embedding"],
      inspectionFailed: true,
      error: "Ollama model embedding-model only supports embeddings. Choose a chat model instead.",
    },
    {
      name: "rejects an inventory known to contain only embedding models before reset",
      models: ["embedding-model"],
      capabilities: ["embedding"],
      error:
        "No Ollama chat models are available at http://ollama-host:11434.\nPull a chat model first, then re-run setup.",
    },
    {
      name: "refuses to pull an unavailable local model during destructive-reset preflight",
      models: [],
      customModelId: "gemma4",
      error:
        "No Ollama models are available at http://ollama-host:11434.\nPull a model first, then re-run setup.",
    },
    {
      name: "preflights an authenticated and confirmed cloud model without pulling it",
      models: [],
      customModelId: "ollama/kimi-k2.5:cloud",
      cloud: "confirmed",
    },
    {
      name: "rejects an unauthenticated Ollama cloud model before destructive reset",
      models: [],
      customModelId: "kimi-k2.5:cloud",
      cloud: "unauthenticated",
      error: "Cloud models on this Ollama host need `ollama signin`.\nhttps://ollama.com/signin",
    },
    {
      name: "rejects a stale catalog-listed Ollama cloud model before destructive reset",
      models: ["kimi-k2.5:cloud"],
      customModelId: "kimi-k2.5:cloud",
      cloud: "unconfirmed",
      error:
        "Ollama model kimi-k2.5:cloud was not found at http://ollama-host:11434.\nAvailable models: kimi-k2.5:cloud",
    },
  ] as Array<{
    name: string;
    models: string[];
    reachable?: boolean;
    customBaseUrl?: string;
    customModelId?: string;
    capabilities?: string[];
    omitListedCapabilities?: boolean;
    inspectionFailed?: boolean;
    cloud?: "confirmed" | "unauthenticated" | "unconfirmed";
    error?: string;
  }>)("$name", async (testCase) => {
    const {
      models,
      reachable = true,
      customBaseUrl,
      customModelId,
      capabilities,
      omitListedCapabilities,
      inspectionFailed,
      cloud,
      error,
    } = testCase;
    modelsMock.mockResolvedValue({
      reachable,
      models: models.map((name) => ({
        name,
        capabilities: omitListedCapabilities ? undefined : capabilities,
      })),
    });
    if (capabilities) {
      showMock.mockResolvedValue({ capabilities });
    }
    if (inspectionFailed) {
      showMock.mockResolvedValue({ showInspectionFailed: true });
    }
    if (cloud === "unauthenticated") {
      guardedFetchMock.mockResolvedValue({
        response: new Response(JSON.stringify({ signin_url: "https://ollama.com/signin" }), {
          status: 401,
        }),
        release: vi.fn(async () => {}),
      });
    }
    if (cloud === "unconfirmed") {
      showMock.mockResolvedValue({});
    }
    const ctx = resetContext({
      customBaseUrl: customBaseUrl ?? "http://ollama-host:11434",
      ...(customModelId ? { customModelId } : {}),
    });
    const validate = registerProvider().auth[0].validateNonInteractive;
    if (error) {
      await expect(validate(ctx)).rejects.toThrow(error);
    } else {
      await expect(validate(ctx)).resolves.toBe(true);
    }
    if (customBaseUrl?.endsWith("/")) {
      expect(modelsMock).toHaveBeenCalledWith("http://ollama-host:11434");
    }
    if (cloud === "confirmed") {
      expect(guardedFetchMock).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://ollama-host:11434/api/me" }),
      );
      expect(showMock).toHaveBeenCalledWith("http://ollama-host:11434", "kimi-k2.5:cloud");
    }
    if (cloud === "unauthenticated") {
      expect(showMock).not.toHaveBeenCalled();
    }
    expect(ctx.runtime.error).not.toHaveBeenCalled();
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
    expect(nonInteractiveMock).not.toHaveBeenCalled();
    expect(pullMock).not.toHaveBeenCalled();
  });

  it("classifies incomplete ollama streams as provider failures", () => {
    const provider = registerProvider();
    expect(
      provider?.classifyFailoverReason?.({
        provider: "ollama",
        errorMessage: "Ollama API stream ended without a final response",
      }),
    ).toBe("server_error");
    expect(
      provider?.classifyFailoverReason?.({
        provider: "ollama",
        errorMessage: "Ollama returned malformed tool arguments",
      }),
    ).toBeUndefined();
  });

  it("keeps the agent tool but does not advertise node inference when disabled locally", () => {
    const registerNodeHostCommand = vi.fn();
    const registerTool = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "ollama",
        pluginConfig: { nodeInference: { enabled: false } },
        runtime: createPluginRuntimeMock(),
        registerNodeHostCommand,
        registerTool,
      }),
    );
    expect(registerNodeHostCommand).not.toHaveBeenCalled();
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "node_inference" }));
  });

  it("carries the selected model from provider auth into model preparation", async () => {
    const provider = registerProvider();
    const prompter = {} as never;
    const result = await provider.auth[0].run({
      config: {},
      prompter,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });
    expect(result.configPatch).toEqual(
      ollamaConfig({
        baseUrl: localBaseUrl,
        api: "ollama",
        apiKey: "ollama-local",
        models: [{ id: "qwen-tool", name: "qwen-tool" }],
      }),
    );
    expect(result.profiles).toEqual([]);
    expect(result.defaultModel).toBe("ollama/qwen-tool");
    await provider.onModelSelected?.({
      config: result.configPatch,
      model: result.defaultModel,
      prompter,
    });
    expect(pullMock).toHaveBeenCalledWith({
      config: result.configPatch,
      model: "ollama/qwen-tool",
      prompter,
    });
  });

  it("discovers and prepares a loaded tool-capable model without pulling it", async () => {
    const provider = registerProvider();
    const guided = provider.auth[0].appGuidedSetup;
    mockInstalledModels({ "embed-only": false, "unknown-tools": undefined, "qwen-tool": true });
    await expect(guided?.detect({ config: {}, env: {} })).resolves.toEqual({
      modelRef: "ollama/qwen-tool",
      detail: "qwen-tool at http://127.0.0.1:11434",
    });
    const prepared = await guided?.prepare({
      config: {},
      env: {},
      modelRef: "ollama/qwen-tool",
    });
    expect(prepared).toMatchObject({
      profiles: [],
      defaultModel: "ollama/qwen-tool",
      configPatch: ollamaConfig({
        baseUrl: localBaseUrl,
        api: "ollama",
        models: [{ id: "qwen-tool" }],
      }),
    });
    expect(prepared?.configPatch?.models?.mode).toBe("merge");
    expect(prepared?.configPatch?.models?.providers?.ollama?.apiKey).toBe(OLLAMA_DEFAULT_API_KEY);
    await expect(
      guided?.prepare({ config: {}, env: {}, modelRef: "ollama/unknown-tools" }),
    ).resolves.toBeNull();
    loadedMock.mockResolvedValue({ reachable: true, models: [] });
    await expect(
      guided?.prepare({ config: {}, env: {}, modelRef: "ollama/qwen-tool" }),
    ).resolves.toBeNull();
    expect(modelsMock).toHaveBeenCalledTimes(3);
    expect(pullMock).not.toHaveBeenCalled();
  });

  it("uses the Docker host default for availability detection during Docker setup", async () => {
    modelsMock.mockResolvedValue({ reachable: true, models: [] });
    await registerProvider().auth[0].appGuidedSetup?.detectAvailability?.({
      config: {},
      env: { OPENCLAW_DOCKER_SETUP: "1" },
    });
    expect(modelsMock).toHaveBeenCalledWith("http://host.docker.internal:11434", {});
  });

  it("does not auto-detect installed models that are not loaded", async () => {
    loadedMock.mockResolvedValue({ reachable: true, models: [] });
    await expect(
      registerProvider().auth[0].appGuidedSetup?.detect({ config: {}, env: {} }),
    ).resolves.toBeNull();
    expect(discoveryMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
  });

  it.each([
    { baseUrl: "https://api.ollama.com", contextTokens: undefined },
    { baseUrl: "https://ollama.com.example/v1", contextTokens: 32_768 },
  ])(
    "prepares the exact configured idle model at $baseUrl with its runtime context",
    async ({ baseUrl, contextTokens }) => {
      const provider = registerProvider();
      const config = ollamaConfig({
        baseUrl,
        apiKey: "fixture-access",
        api: "ollama" as const,
        models: [
          {
            ...createModel("qwen-tool", "qwen-tool", { contextWindow: 32_768 }),
            compat: { supportsTools: true },
          },
        ],
      });
      loadedMock.mockResolvedValue({ reachable: true, models: [] });
      mockInstalledModels({ "qwen-tool": true });
      mockShow(["completion", "tools"], 262_144);
      const result = await provider.auth[0].appGuidedSetup?.prepare({
        config,
        env: {},
        modelRef: "ollama/qwen-tool",
      });
      expect(result).toMatchObject({
        defaultModel: "ollama/qwen-tool",
        configPatch: ollamaConfig({
          models: [expect.objectContaining({ id: "qwen-tool" })],
        }),
      });
      const prepared = result?.configPatch?.models?.providers?.ollama?.models?.[0];
      expect(prepared?.contextWindow).toBe(262_144);
      expect(prepared?.contextTokens).toBe(contextTokens);
      expect(loadedMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an explicit installed model that setup did not configure", async () => {
    mockInstalledModels({ "other-model": true });
    await expect(
      registerProvider().auth[0].appGuidedSetup?.prepare({
        config: {},
        env: {},
        modelRef: "ollama/other-model",
      }),
    ).resolves.toBeNull();
    expect(showMock).not.toHaveBeenCalled();
  });

  it("skips preferred models whose measured context is below 16k", async () => {
    mockInstalledModels({ "llama3.3:70b": true, "qwen3.5:4b": true });
    showMock.mockImplementation(async (_baseUrl: string, modelId: string) => ({
      contextWindow: modelId === "qwen3.5:4b" ? 8_192 : 16_384,
      capabilities: ["completion", "tools"],
    }));
    await expect(
      registerProvider().auth[0].appGuidedSetup?.detect({ config: {}, env: {} }),
    ).resolves.toEqual({
      modelRef: "ollama/llama3.3:70b",
      detail: "llama3.3:70b at http://127.0.0.1:11434",
    });
  });

  it("keeps environment-backed Ollama access for the completion proposal", async () => {
    const configuredValue = "environment-access";
    const providerAccess = { apiKey: configuredValue };
    const environment = { OLLAMA_API_KEY: configuredValue };
    mockInstalledModels({ "qwen-tool": true });
    const prepared = await registerProvider().auth[0].appGuidedSetup?.prepare({
      config: ollamaConfig({
        baseUrl: "https://ollama.example.com",
        api: "ollama",
        models: [],
      }),
      env: environment,
      modelRef: "ollama/qwen-tool",
    });
    expect(modelsMock).toHaveBeenCalledWith(
      "https://ollama.example.com",
      expect.objectContaining(providerAccess),
    );
    expect(prepared?.configPatch?.models?.providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
  });

  it("does not send the ambient Ollama cloud key to automatic localhost discovery", async () => {
    const configuredValue = "cloud-access";
    const environment = { OLLAMA_API_KEY: configuredValue };
    mockInstalledModels({ "qwen-tool": true });
    await registerProvider().auth[0].appGuidedSetup?.detect({ config: {}, env: environment });
    const options = modelsMock.mock.calls.at(-1)?.[1] as
      | { apiKey?: string; quiet?: boolean }
      | undefined;
    expect(options?.apiKey).toBeUndefined();
    expect(loadedMock).toHaveBeenCalledWith(localBaseUrl, {});
  });

  it("honors the Ollama discovery opt-out during app-guided detection", async () => {
    const provider = registerProvider();
    const context = {
      config: discoveryConfig(false),
      env: {},
    };
    await expect(provider.auth[0].appGuidedSetup?.detect(context)).resolves.toBeNull();
    await expect(provider.auth[0].appGuidedSetup?.detectAvailability?.(context)).resolves.toBe(
      false,
    );
    expect(loadedMock).not.toHaveBeenCalled();
    expect(discoveryMock).not.toHaveBeenCalled();
    expect(modelsMock).not.toHaveBeenCalled();
  });

  it("skips ambient discovery when plugin discovery is disabled", async () => {
    const provider = registerProvider({ discovery: { enabled: false } });
    const result = await runCatalog(
      provider,
      { apiKey: "", discoveryApiKey: "" },
      discoveryConfig(false),
    );
    expect(result).toBeNull();
    expect(discoveryMock).not.toHaveBeenCalled();
  });

  it("uses live plugin config to re-enable discovery after startup disable", async () => {
    const provider = registerProvider({ discovery: { enabled: false } });
    mockDiscovery([{ id: "llama3.2", name: "Llama 3.2" }]);
    const result = await runCatalog(
      provider,
      { apiKey: "profile-key", discoveryApiKey: "profile-key" },
      discoveryConfig(true),
      { OLLAMA_API_KEY: "cloud-key" },
    );
    expect(discoveryMock).toHaveBeenCalledOnce();
    expect(discoveryMock).toHaveBeenCalledWith(undefined, {
      discoveryMode: "strict",
      apiKey: "profile-key",
    });
    expect(result).toEqual({
      outcomes: [{ provider: "ollama", status: "ready" }],
      provider: {
        baseUrl: localBaseUrl,
        api: "ollama",
        models: [{ id: "llama3.2", name: "Llama 3.2" }],
        apiKey: "profile-key",
      },
    });
  });

  it("accepts baseURL alias as explicit discovery config", async () => {
    const provider = registerProvider();
    mockDiscovery([], "http://remote-ollama:11434");
    const result = await runCatalog(
      provider,
      { apiKey: "" },
      ollamaConfig({
        baseURL: "http://remote-ollama:11434",
        api: "ollama",
        models: [],
      }),
      { NODE_ENV: "development" },
    );
    expect(result).toMatchObject({
      provider: { models: [] },
      outcomes: [{ provider: "ollama", status: "ready" }],
    });
    expect(discoveryMock).toHaveBeenCalledWith("http://remote-ollama:11434", {
      discoveryMode: "strict",
    });
  });

  it("preserves explicit api for configured dynamic Ollama models", async () => {
    const provider = registerProvider();
    vi.stubEnv("OLLAMA_API_KEY", "ollama-live");
    mockDiscovery(
      [
        createModel("qwen3-coder:cloud", "qwen3-coder:cloud", {
          contextWindow: 8192,
          maxTokens: 2048,
        }),
      ],
      "https://ollama.example.com",
    );
    const config = ollamaConfig({
      baseUrl: "https://ollama.example.com/v1",
      api: "openai-completions",
      models: [],
    });
    const context = dynamicContext("qwen3-coder:cloud", config);
    const resolved = await provider.prepareDynamicModel?.(context as never);
    expect(resolved?.provider).toBe("ollama");
    expect(resolved?.id).toBe("qwen3-coder:cloud");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe("https://ollama.example.com/v1");
    expect(discoveryMock).toHaveBeenCalledWith("https://ollama.example.com/v1", {
      quiet: true,
      apiKey: "ollama-live",
    });
  });

  it("returns the exact prepared Ollama model for concurrent credential profiles", async () => {
    const provider = registerProvider();
    const baseUrl = "https://shared-dynamic-ollama.example.com";
    const modelId = "tenant-dynamic-model";
    const configFor = (apiKey: string) =>
      createModelProviderConfig({
        ollama: { baseUrl, api: "ollama" as const, apiKey, models: [] },
      });
    const discoveredFor = (name: string) => ({
      baseUrl,
      api: "ollama" as const,
      models: [{ id: modelId, name, contextWindow: 8192, maxTokens: 2048 }],
    });
    const completeDiscovery: Array<(result: ReturnType<typeof discoveredFor>) => void> = [];
    const started = Promise.withResolvers<void>();
    discoveryMock.mockImplementation(
      () =>
        new Promise<ReturnType<typeof discoveredFor>>((resolve) => {
          completeDiscovery.push(resolve);
          if (completeDiscovery.length === 2) {
            started.resolve();
          }
        }),
    );
    const prepareFor = (apiKey: string, authProfileId: string) =>
      provider.prepareDynamicModel?.({
        ...dynamicContext(modelId, configFor(apiKey)),
        authProfileId,
      } as never);
    const firstPrepared = prepareFor("first-tenant-access", "ollama:first");
    const secondPrepared = prepareFor("second-tenant-access", "ollama:second");
    await started.promise;
    expect(discoveryMock).toHaveBeenCalledTimes(2);
    completeDiscovery[1]?.(discoveredFor("Second tenant model"));
    await expect(secondPrepared).resolves.toMatchObject({
      id: modelId,
      name: "Second tenant model",
    });
    completeDiscovery[0]?.(discoveredFor("First tenant model"));
    await expect(firstPrepared).resolves.toMatchObject({ id: modelId, name: "First tenant model" });
    expect(discoveryMock).toHaveBeenNthCalledWith(1, baseUrl, {
      quiet: true,
      apiKey: "first-tenant-access",
    });
    expect(discoveryMock).toHaveBeenNthCalledWith(2, baseUrl, {
      quiet: true,
      apiKey: "second-tenant-access",
    });
  });

  it("preserves opaque environment-backed SecretRef value OLLAMA_API_KEY for dynamic discovery", async () => {
    const secretValue = "OLLAMA_API_KEY";
    const provider = registerProvider();
    const baseUrl = "https://secretref-dynamic-ollama.example.com";
    const envId = "VITEST_OLLAMA_DYNAMIC_DISCOVERY_KEY";
    vi.stubEnv(envId, secretValue);
    const config = createModelProviderConfig({
      ollama: {
        baseUrl,
        api: "ollama" as const,
        apiKey: { source: "env" as const, provider: "default", id: envId },
        models: [],
      },
    });
    mockDiscovery([], baseUrl);
    const context = dynamicContext("secretref-dynamic-model", config);
    const resolved = await provider.prepareDynamicModel?.(context as never);
    expect(resolved?.id).toBe("secretref-dynamic-model");
    expect(discoveryMock).toHaveBeenCalledWith(baseUrl, {
      quiet: true,
      apiKey: secretValue,
    });
    expect(showMock).toHaveBeenCalledWith(baseUrl, "secretref-dynamic-model", {
      apiKey: secretValue,
    });
  });

  it("fails closed when a dynamic Ollama SecretRef cannot be resolved", async () => {
    const provider = registerProvider();
    const envId = "VITEST_OLLAMA_DYNAMIC_MISSING_KEY";
    vi.stubEnv(envId, undefined);
    const context = dynamicContext(
      "unreachable-private-model",
      ollamaConfig({
        baseUrl: "https://missing-secretref-ollama.example.com",
        api: "ollama",
        apiKey: { source: "env", provider: "default", id: envId },
        models: [],
      }),
    );
    await expect(provider.prepareDynamicModel?.(context as never)).resolves.toBeUndefined();
    expect(discoveryMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
  });

  it("keeps rotated managed SecretRefs request-owned and fails closed when unavailable", async () => {
    const provider = registerProvider();
    const baseUrl = "https://managed-dynamic-ollama.example.com";
    const modelId = "managed-private-model";
    const config = createModelProviderConfig({
      ollama: {
        baseUrl,
        api: "ollama" as const,
        apiKey: { source: "file" as const, provider: "default", id: "/ollama/apiKey" },
        models: [],
      },
    });
    secretMock
      .mockResolvedValueOnce({ value: "managed-dynamic-access" })
      .mockResolvedValueOnce({ value: "rotated-managed-access" })
      .mockResolvedValueOnce({ unresolvedRefReason: "managed credential is unavailable" });
    mockDiscovery([{ id: modelId, name: "Managed private model", contextWindow: 8192 }], baseUrl);
    mockDiscovery([{ id: modelId, name: "Rotated managed model", contextWindow: 8192 }], baseUrl);
    const context = dynamicContext(modelId, config);
    await expect(provider.prepareDynamicModel?.(context as never)).resolves.toMatchObject({
      id: modelId,
      name: "Managed private model",
    });
    await expect(provider.prepareDynamicModel?.(context as never)).resolves.toMatchObject({
      id: modelId,
      name: "Rotated managed model",
    });
    await expect(provider.prepareDynamicModel?.(context as never)).resolves.toBeUndefined();
    expect(discoveryMock).toHaveBeenNthCalledWith(2, baseUrl, {
      quiet: true,
      apiKey: "rotated-managed-access",
    });
    expect(discoveryMock).toHaveBeenCalledTimes(2);
  });

  it("resolves a requested cloud model through local show without a context cap", async () => {
    const { baseUrl, modelId } = { baseUrl: localBaseUrl, modelId: "deepseek-v4-pro:cloud" };
    const provider = registerProvider();
    vi.stubEnv("OLLAMA_API_KEY", "ollama-local");
    mockDiscovery(
      [
        createModel("kimi-k2.5:cloud", "kimi-k2.5:cloud", {
          reasoning: true,
          contextWindow: 262144,
        }),
      ],
      baseUrl,
    );
    mockShow(["completion", "tools", "thinking"]);
    const context = dynamicContext(
      modelId,
      ollamaConfig({ baseUrl, api: "ollama", apiKey: "fixture-access", models: [] }),
    );
    const resolved = await provider.prepareDynamicModel?.(context as never);
    expect(showMock).toHaveBeenCalledWith(baseUrl, modelId, {
      apiKey: "fixture-access",
    });
    expect(resolved?.provider).toBe("ollama");
    expect(resolved?.id).toBe(modelId);
    expect(resolved?.api).toBe("ollama");
    expect(resolved?.baseUrl).toBe(baseUrl);
    expect(resolved?.contextWindow).toBe(1_048_576);
    expect(resolved?.contextTokens).toBeUndefined();
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.compat?.supportsTools).toBe(true);
  });

  it("reconciles configured refs and incomplete catalog rows without probing complete rows", async () => {
    showMock.mockResolvedValue({
      contextWindow: 1_048_576,
      capabilities: ["completion", "tools", "thinking", "vision"],
    });
    const rows = await augmentCatalog(registerProvider(), {
      config: {
        agents: {
          defaults: {
            heartbeat: { model: "ollama/heartbeat:cloud" },
            model: { primary: "openai/gpt-5.5", fallbacks: ["ollama/global-fallback:cloud"] },
          },
          entries: { ops: { model: { primary: "ollama/per-agent:cloud@work" } } },
        },
      },
      entries: [
        {
          provider: "ollama",
          id: "minimax-m3:cloud",
          name: "Configured Minimax M3",
          api: "openai-completions",
          contextWindow: 128_000,
        },
        {
          provider: "ollama",
          id: "fully-configured",
          name: "Fully configured",
          contextWindow: 128_000,
          reasoning: false,
          input: ["text"],
          compat: { supportsTools: false },
        },
      ],
    });
    const expected = [
      ["global-fallback:cloud", "global-fallback:cloud", "ollama"],
      ["heartbeat:cloud", "heartbeat:cloud", "ollama"],
      ["per-agent:cloud", "per-agent:cloud", "ollama"],
      ["minimax-m3:cloud", "Configured Minimax M3", "openai-completions"],
    ];
    expect(showMock.mock.calls).toEqual(expected.map(([id]) => [localBaseUrl, id]));
    expect(rows).toEqual(
      expected.map(([id, name, api]) =>
        expect.objectContaining({
          provider: "ollama",
          id,
          name,
          api,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_048_576,
          compat: {
            supportsTools: true,
            supportsUsageInStreaming: true,
            supportsJsonSchemaResponseFormat: false,
          },
        }),
      ),
    );
  });

  it.each([
    {
      name: "configured remote credential",
      providerId: "ollama",
      modelId: "remote-new",
      baseUrl: "https://ollama.example.test",
      configuredKey: "remote-key",
      env: {},
      resolved: { apiKey: "" },
      expectedKey: "remote-key",
      capabilities: ["completion", "tools", "thinking"],
    },
    {
      name: "explicit local SecretRef",
      providerId: "ollama",
      modelId: "local-secured",
      baseUrl: localBaseUrl,
      configuredKey: { source: "env", provider: "default", id: "LOCAL_OLLAMA_API_KEY" },
      env: { LOCAL_OLLAMA_API_KEY: "local-key", OLLAMA_API_KEY: "ambient-cloud-key" },
      resolved: { apiKey: "LOCAL_OLLAMA_API_KEY", discoveryApiKey: "local-key" },
      expectedKey: "local-key",
      capabilities: ["completion", "tools", "thinking"],
    },
    {
      name: "ambient cloud credential excluded from local probe",
      providerId: "ollama",
      modelId: "local-open",
      env: { OLLAMA_API_KEY: "ambient-cloud-key" },
      resolved: { apiKey: "OLLAMA_API_KEY", discoveryApiKey: "ambient-cloud-key" },
      expectedKey: undefined,
      capabilities: ["completion", "tools"],
    },
    {
      name: "resolved cloud credential instead of marker",
      providerId: "ollama-cloud",
      modelId: "cloud-new:cloud",
      env: {},
      resolved: { apiKey: "secretref-managed", discoveryApiKey: "cloud-key" },
      expectedKey: "cloud-key",
      capabilities: ["completion", "thinking"],
    },
  ])("authenticates catalog probes with $name", async (entry) => {
    const provider =
      entry.providerId === "ollama" ? registerProvider() : registerOllamaCloudProvider();
    mockShow(entry.capabilities);
    const rows = await augmentCatalog(provider, {
      config: {
        ...configuredRefs(`${entry.providerId}/${entry.modelId}`),
        ...(entry.baseUrl
          ? ollamaConfig({ baseUrl: entry.baseUrl, api: "ollama", apiKey: entry.configuredKey })
          : {}),
      },
      env: entry.env,
      resolveProviderApiKey: () => entry.resolved,
    });
    const baseUrl = entry.baseUrl ?? (entry.providerId === "ollama" ? localBaseUrl : cloudBaseUrl);
    expect(showMock.mock.calls).toEqual([
      entry.expectedKey
        ? [baseUrl, entry.modelId, { apiKey: entry.expectedKey }]
        : [baseUrl, entry.modelId],
    ]);
    expect(rows).toMatchObject([
      { provider: entry.providerId, id: entry.modelId, contextWindow: 1_048_576 },
    ]);
  });

  it("does not probe Ollama Cloud catalog with non-secret auth markers", async () => {
    const provider = registerOllamaCloudProvider();
    const rows = await augmentCatalog(provider, {
      config: configuredRefs("ollama-cloud/cloud-new:cloud"),
      env: { OLLAMA_API_KEY: "secretref-managed" }, // pragma: allowlist secret
      resolveProviderApiKey: vi.fn(() => ({
        apiKey: "secretref-managed", // pragma: allowlist secret
      })),
    });
    expect(showMock).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("bounds configured Ollama show probes", async () => {
    const provider = registerProvider();
    let active = 0;
    let maxActive = 0;
    showMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        contextWindow: 1_048_576,
        capabilities: ["completion", "thinking"],
      };
    });
    const rows = await augmentCatalog(provider, {
      entries: Array.from({ length: 10 }, (_, index) => ({
        provider: "ollama",
        id: `model-${index}:cloud`,
        name: `model-${index}:cloud`,
      })),
    });
    expect(rows).toHaveLength(8);
    expect(showMock).toHaveBeenCalledTimes(8);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("keeps unknown requested Ollama models unresolved when show inspection fails", async () => {
    const provider = registerProvider();
    vi.stubEnv("OLLAMA_API_KEY", "ollama-local");
    mockDiscovery([]);
    showMock.mockResolvedValueOnce({ showInspectionFailed: true });
    const context = dynamicContext("depseek-v4-pro:cloud");
    await expect(provider.prepareDynamicModel?.(context as never)).resolves.toBeUndefined();
  });

  it("skips implicit localhost discovery when a custom remote Ollama provider is configured", async () => {
    const provider = registerProvider();
    const result = await runCatalog(
      provider,
      { apiKey: "ollama-live" },
      createModelProviderConfig({
        "ollama-cloud": {
          api: "ollama",
          baseUrl: cloudBaseUrl,
          models: [createModel("kimi-k2.5", "Kimi K2.5")],
        },
      }),
      { NODE_ENV: "development", OLLAMA_API_KEY: "ollama-live" },
    );
    expect(result).toBeNull();
    expect(discoveryMock).not.toHaveBeenCalled();
  });

  it("treats custom 127/8 Ollama provider [::ffff:7f00:2] as loopback for implicit discovery", async () => {
    const hostname = "[::ffff:7f00:2]";
    const provider = registerProvider();
    mockDiscovery([]);
    const result = await runCatalog(
      provider,
      { apiKey: "ollama-live" },
      createModelProviderConfig({
        "ollama-alt-local": {
          api: "ollama",
          baseUrl: `http://${hostname}:11434`,
          models: [createModel("llama3.2", "Llama 3.2")],
        },
      }),
      { NODE_ENV: "development", OLLAMA_API_KEY: "ollama-live" },
    );
    const resultProvider = result?.provider;
    expect(resultProvider.baseUrl).toBe(localBaseUrl);
    expect(discoveryMock).toHaveBeenCalledWith(undefined, {
      discoveryMode: "strict",
    });
  });

  it.each([
    {
      name: "keeps empty default provider stubs unauthenticated and undiscovered",
      providerPatch: { baseUrl: localBaseUrl },
      mintsAuth: false,
      checkCatalog: true,
    },
    {
      name: "does not mint synthetic auth for a public IPv4 endpoint",
      providerPatch: { baseUrl: "http://8.8.8.8:11434" },
      mintsAuth: false,
      checkCatalog: false,
    },
    {
      name: "mints synthetic auth for non-default baseURL alias config",
      providerPatch: { baseURL: "http://remote-ollama:11434" },
      mintsAuth: true,
      checkCatalog: false,
    },
  ])("$name", async ({ providerPatch, mintsAuth, checkCatalog }) => {
    const provider = registerProvider();
    const providerConfig = { api: "ollama", models: [], ...providerPatch };
    const auth = provider.resolveSyntheticAuth?.({ providerConfig });
    if (mintsAuth) {
      expect(auth).toEqual({
        apiKey: "ollama-local",
        source: "models.providers.ollama (synthetic local key)",
        mode: "api-key",
      });
    } else {
      expect(auth).toBeUndefined();
    }
    if (checkCatalog) {
      await expect(
        runCatalog(provider, { apiKey: "" }, ollamaConfig(providerConfig)),
      ).resolves.toBeNull();
      expect(discoveryMock).not.toHaveBeenCalled();
    }
  });

  it("reports cloud catalog authentication rejection with its profile", async () => {
    discoveryMock.mockRejectedValue(new LiveModelCatalogHttpError("ollama-cloud", 401));
    const result = await runCatalog(registerOllamaCloudProvider(), {
      apiKey: "catalog-key",
      discoveryApiKey: "catalog-key",
      profileId: "ollama-cloud:default",
    });
    expect(result).toEqual({
      providers: {},
      outcomes: [
        {
          provider: "ollama-cloud",
          profileId: "ollama-cloud:default",
          status: "auth-rejected",
          rejectionScope: "catalog",
        },
      ],
    });
  });

  it("keeps ollama-cloud live empties authoritative", async () => {
    const provider = registerOllamaCloudProvider();
    mockDiscovery([]);
    const result = await runCatalog(provider, {
      apiKey: "catalog-key",
      discoveryApiKey: "catalog-key",
    });
    expect(result).toMatchObject({
      provider: { models: [] },
      outcomes: [{ provider: "ollama-cloud", status: "ready" }],
    });
    expect(showMock).not.toHaveBeenCalled();
  });

  it("uses Ollama Cloud auth for live catalog discovery", async () => {
    const provider = registerOllamaCloudProvider();
    mockDiscovery([buildOllamaModelDefinition("glm-5.2")], cloudBaseUrl);
    const result = await runCatalog(provider, {
      apiKey: "OLLAMA_API_KEY",
      discoveryApiKey: "cloud-key",
    });
    expect(discoveryMock).toHaveBeenCalledWith(cloudBaseUrl, {
      apiKey: "cloud-key",
      discoveryMode: "strict",
    });
    expect(result?.provider.apiKey).toBe("OLLAMA_API_KEY");
    expect(result?.provider.models).toContainEqual(
      expect.objectContaining({ id: "glm-5.2", name: "glm-5.2" }),
    );
  });

  it("confirms GLM-5.2 with authenticated show when cloud tags omit it", async () => {
    const provider = registerOllamaCloudProvider();
    mockDiscovery([buildOllamaModelDefinition("kimi-k2.6")], cloudBaseUrl);
    mockShow(["completion", "thinking", "tools"], 1_000_000);
    const result = await runCatalog(
      provider,
      {
        apiKey: "secretref-managed",
        discoveryApiKey: "cloud-key",
      },
      {
        agents: { defaults: { model: { primary: "ollama-cloud/glm-5.2" } } },
      },
    );
    expect(discoveryMock).toHaveBeenCalledWith(cloudBaseUrl, {
      apiKey: "cloud-key",
      discoveryMode: "strict",
    });
    expect(showMock).toHaveBeenCalledWith(cloudBaseUrl, "glm-5.2", {
      apiKey: "cloud-key",
    });
    expect(result?.provider.models).toContainEqual(
      expect.objectContaining({
        id: "glm-5.2",
        contextWindow: 1_000_000,
        maxTokens: 8192,
        reasoning: true,
      }),
    );
  });

  it("lists and resolves GLM-5.2 from the offline cloud catalog", async () => {
    const provider = registerOllamaCloudProvider();
    const catalog = await provider.staticCatalog.run({});
    expect(catalog.provider.models).toContainEqual(expect.objectContaining({ id: "glm-5.2" }));
    const model = provider.resolveDynamicModel?.({
      provider: "ollama-cloud",
      modelId: "glm-5.2",
    } as never);
    expect(model).toMatchObject({
      provider: "ollama-cloud",
      id: "glm-5.2",
      contextWindow: 1_000_000,
      maxTokens: 8192,
      reasoning: true,
    });
    expect(model?.contextTokens).toBeUndefined();
  });

  it("wraps OpenAI-compatible payloads with num_ctx for Ollama compat routes", async () => {
    const provider = registerProvider();
    const payloadResult = Promise.resolve();
    const onPayload = vi.fn((payload: unknown) => {
      expect(payload).toEqual({ options: { temperature: 0.1, num_ctx: 32_768 } });
      return payloadResult;
    });
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = { options: { temperature: 0.1 } };
      expect(options?.onPayload?.(payload, _model)).toBe(payloadResult);
      return {} as never;
    });
    const wrapped = provider.wrapStreamFn?.({
      config: ollamaConfig({
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [],
      }),
      provider: "ollama",
      modelId: "qwen3:32b",
      model: {
        api: "openai-completions",
        provider: "ollama",
        id: "qwen3:32b",
        baseUrl: "http://127.0.0.1:11434/v1",
        contextWindow: 202_752,
        contextTokens: 32_768,
      },
      streamFn: baseStreamFn,
    });
    if (!wrapped) {
      throw new Error("expected Ollama OpenAI-compatible stream wrapper");
    }
    await wrapped({} as never, {} as never, { onPayload });
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(onPayload).toHaveBeenCalledOnce();
  });

  it("does not start the ollama stream after cancellation during wrapper preparation", async () => {
    const api = "ollama";
    const provider = registerProvider();
    const controller = new AbortController();
    const reason = new Error("stream canceled during preparation");
    const baseStreamFn = vi.fn(() => ({}) as never);
    const model = {
      api,
      provider: "ollama",
      id: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindow: 32_768,
    };
    const wrapped = expectDefined(
      provider.wrapStreamFn?.({
        provider: "ollama",
        modelId: model.id,
        model,
        streamFn: baseStreamFn,
        thinkingLevel: "high",
      }),
      "Ollama stream wrapper",
    );
    const pending = wrapped(model as never, { messages: [] }, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(baseStreamFn).not.toHaveBeenCalled();
  });

  it("preserves the original stream when no Ollama wrapper applies", () => {
    const provider = registerProvider();
    const streamFn = vi.fn(() => ({}) as never);
    const context = { provider: "ollama", modelId: "qwen3:32b" };
    expect(provider.wrapStreamFn?.({ ...context, streamFn })).toBe(streamFn);
    expect(provider.wrapStreamFn?.(context)).toBeUndefined();
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("owns replay policy for OpenAI-compatible and native Ollama routes", () => {
    const provider = registerProvider();
    const replay = (modelApi: "ollama" | "openai-completions") =>
      provider.buildReplayPolicy?.({
        provider: "ollama",
        modelApi,
        modelId: "qwen3:32b",
      });
    expect(replay("openai-completions")).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });
    const nativePolicy = replay("ollama");
    expect(nativePolicy?.sanitizeToolCallIds).toBe(false);
    expect(nativePolicy?.toolCallIdMode).toBeUndefined();
  });

  it("selects cloud native transport with the default URL only for api=ollama", () => {
    const provider = registerOllamaCloudProvider();
    const createStream = (api: "ollama" | "openai-completions") =>
      provider.createStreamFn?.({
        config: {},
        provider: "ollama-cloud",
        model: { api, id: "qwen3:32b", provider: "ollama-cloud" },
      });
    expect(createStream("openai-completions")).toBeUndefined();
    expect(streamMock).not.toHaveBeenCalled();
    expect(createStream("ollama")).toBeDefined();
    expect(streamMock).toHaveBeenCalledOnce();
    expect(streamMock.mock.calls[0]?.[0]?.providerBaseUrl).toBe(cloudBaseUrl);
  });

  it("preserves the configured provider key for local-service acquisition", () => {
    const provider = registerProvider();
    provider.createStreamFn?.({
      config: {
        models: {
          providers: {
            "Ollama-GPU": {
              api: "ollama",
              baseURL: "http://127.0.0.1:11435",
              models: [],
            },
          },
        },
      },
      model: {
        id: "llama3.2",
        provider: "ollama-gpu",
        api: "ollama",
      },
      provider: "ollama-gpu",
    } as never);
    expect(streamMock.mock.calls[0]?.[0]).toMatchObject({
      providerBaseUrl: "http://127.0.0.1:11435",
      localService: {
        providerId: "Ollama-GPU",
        acquire: expect.any(Function),
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
