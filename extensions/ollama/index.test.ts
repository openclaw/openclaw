import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderAuthMethod, ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createNonExitingRuntimeEnv,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../test-support/model-provider-config.test-support.js";
import plugin from "./index.js";
import { createModel } from "./model.test-support.js";
import { OLLAMA_DEFAULT_API_KEY } from "./src/discovery-shared.js";
import { buildOllamaModelDefinition } from "./src/provider-models.js";

const localBaseUrl = "http://127.0.0.1:11434";
const cloudBaseUrl = "https://ollama.com";
type TestConfig = Record<string, unknown>;

const setupMock = vi.hoisted(() =>
  vi.fn(async () => ({
    defaultModel: "ollama/qwen-tool",
    config: setupConfig(),
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

let provider: ReturnType<typeof registerProvider>;
let guided: ReturnType<typeof registerProvider>["auth"][0]["appGuidedSetup"];

afterEach(() => vi.unstubAllEnvs());

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
    models: ["qwen-tool", "unknown-tools"],
  });
  discoveryMock.mockReset();
  showMock.mockReset().mockResolvedValue(showInfo());
  provider = registerProvider();
  guided = provider.auth[0].appGuidedSetup;
});

function registerProvider(pluginConfig: TestConfig = {}, id = "ollama") {
  const registerProviderMock = vi.fn();
  plugin.register(
    createTestPluginApi({
      id: "ollama",
      pluginConfig,
      runtime: createPluginRuntimeMock(),
      registerProvider: registerProviderMock,
    }),
  );
  return registerProviderMock.mock.calls.map((call) => call[0]).find((entry) => entry.id === id);
}

const registerOllamaCloudProvider = () => registerProvider({}, "ollama-cloud");

it.each([
  [localBaseUrl, cloudBaseUrl, undefined],
  [cloudBaseUrl, localBaseUrl, "off"],
] as const)(
  "prepares compaction thinking at %s with configured URL %s",
  (baseUrl, providerBaseUrl, expected) => {
    const model: ProviderRuntimeModel = {
      provider: "ollama",
      api: "ollama",
      baseUrl,
      ...createModel("qwen3.5:4b", "qwen3.5:4b", { reasoning: true, contextWindow: 32_768 }),
      params: { think: true },
    };
    const resolved =
      provider.normalizeResolvedModel?.({
        provider: model.provider,
        modelId: model.id,
        model,
        config: ollamaConfig({ baseUrl: providerBaseUrl, api: "ollama", models: [] }),
      }) ?? model;
    expect(resolved.compactionThinkingDefault).toBe(expected);
    expect(resolved).toMatchObject(model);
    expect(model).not.toHaveProperty("compactionThinkingDefault");
  },
);

const configuredRefs = (ref: string) => ({ agents: { defaults: { models: { [ref]: {} } } } });

function discoveryConfig(enabled: boolean) {
  return { plugins: { entries: { ollama: { config: { discovery: { enabled } } } } } };
}

const ollamaConfig = <T extends object>(config: T) => ({
  models: { providers: { ollama: config } },
});

function setupConfig() {
  return ollamaConfig({
    baseUrl: localBaseUrl,
    api: "ollama",
    apiKey: "ollama-local",
    models: [{ id: "qwen-tool", name: "qwen-tool" }],
  });
}

function resetContext(
  opts: Record<string, unknown> = {},
): Parameters<NonNullable<ProviderAuthMethod["validateNonInteractive"]>>[0] {
  return {
    authChoice: "ollama",
    config: {},
    baseConfig: {},
    opts,
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: vi.fn(async () => null),
  };
}

function mockDiscovery(models: TestConfig[], baseUrl = localBaseUrl) {
  discoveryMock.mockResolvedValueOnce({ baseUrl, api: "ollama", models });
}

const showInfo = (capabilities = ["completion", "tools"], contextWindow = 32_768) => ({
  contextWindow,
  capabilities,
});

const mockShow = (capabilities: string[], contextWindow = 1_048_576) =>
  showMock.mockResolvedValueOnce(showInfo(capabilities, contextWindow));

const expectDiscoveryKey = (baseUrl: string, apiKey: string, call = 1) =>
  expect(discoveryMock).toHaveBeenNthCalledWith(call, baseUrl, { quiet: true, apiKey });

const expectShowKey = (baseUrl: string, modelId: string, apiKey: string) =>
  expect(showMock).toHaveBeenCalledWith(baseUrl, modelId, { apiKey });

const dynamicConfig = (baseUrl: string, apiKey: ModelProviderConfig["apiKey"]) =>
  ollamaConfig({ baseUrl, api: "ollama" as const, apiKey, models: [] });

function prepareDynamic(modelId: string, config: TestConfig = {}, authProfileId?: string) {
  return provider.prepareDynamicModel?.({
    ...dynamicContext(modelId, config),
    authProfileId,
  } as never);
}

function prepareGuided(
  modelRef = "ollama/qwen-tool",
  config: TestConfig = {},
  env: NodeJS.ProcessEnv = {},
) {
  return guided?.prepare({ modelRef, config, env });
}

function mockInstalledModels(models: Record<string, boolean | undefined>, parameterCount?: number) {
  modelsMock.mockResolvedValue({
    reachable: true,
    models: Object.keys(models).map((name) => ({ name })),
  });
  showMock.mockImplementation(async (_baseUrl: string, modelId: string) => ({
    contextWindow: 32_768,
    capabilities: models[modelId] ? ["completion", "tools"] : ["completion"],
    ...(parameterCount !== undefined ? { parameterCount } : {}),
  }));
}

function dynamicContext(modelId: string, config: TestConfig = {}) {
  return {
    config,
    provider: "ollama",
    modelId,
    modelRegistry: { find: vi.fn(() => null) },
  };
}

async function runCatalog(
  target: ReturnType<typeof registerProvider>,
  auth: { apiKey?: string; discoveryApiKey?: string; profileId?: string },
  config: TestConfig = {},
  env: NodeJS.ProcessEnv = {},
) {
  return await target.catalog.run({ config, env, resolveProviderApiKey: () => auth });
}

async function augmentCatalog(
  target: ReturnType<typeof registerProvider>,
  overrides: TestConfig = {},
) {
  return await target.augmentModelCatalog?.({
    config: {},
    env: process.env,
    entries: [],
    ...overrides,
  } as never);
}

describe("ollama plugin", () => {
  type PreflightOptions = {
    reachable?: boolean;
    customBaseUrl?: string;
    customModelId?: string;
    capabilities?: string[];
    inspectionFailed?: boolean;
    cloud?: "confirmed" | "unauthenticated" | "unconfirmed";
  };
  it.each<[string, string[], PreflightOptions, string?]>([
    [
      "unreachable endpoint",
      [],
      { reachable: false },
      "Ollama could not be reached at http://ollama-host:11434.\nDownload it at https://ollama.com/download",
    ],
    [
      "missing requested model",
      ["qwen2.5-coder:7b"],
      { customModelId: "gemma4" },
      "Ollama model gemma4 was not found at http://ollama-host:11434.\nAvailable models: qwen2.5-coder:7b",
    ],
    [
      "implicit latest tag",
      ["gemma4:latest"],
      { customBaseUrl: "http://ollama-host:11434/", customModelId: "ollama/gemma4" },
    ],
    [
      "failed embedding inspection",
      ["embedding-model"],
      { customModelId: "embedding-model", capabilities: ["embedding"], inspectionFailed: true },
      "Ollama model embedding-model only supports embeddings. Choose a chat model instead.",
    ],
    [
      "embedding-only inventory",
      ["embedding-model"],
      { capabilities: ["embedding"] },
      "No Ollama chat models are available at http://ollama-host:11434.\nPull a chat model first, then re-run setup.",
    ],
    [
      "empty local inventory",
      [],
      { customModelId: "gemma4" },
      "No Ollama models are available at http://ollama-host:11434.\nPull a model first, then re-run setup.",
    ],
    ["confirmed cloud model", [], { customModelId: "ollama/kimi-k2.5:cloud", cloud: "confirmed" }],
    [
      "unauthenticated cloud model",
      [],
      { customModelId: "kimi-k2.5:cloud", cloud: "unauthenticated" },
      "Cloud models on this Ollama host need `ollama signin`.\nhttps://ollama.com/signin",
    ],
    [
      "stale cloud model",
      ["kimi-k2.5:cloud"],
      { customModelId: "kimi-k2.5:cloud", cloud: "unconfirmed" },
      "Ollama model kimi-k2.5:cloud was not found at http://ollama-host:11434.\nAvailable models: kimi-k2.5:cloud",
    ],
  ])("preflights %s without pulling or resetting", async (_name, models, options, error) => {
    const {
      reachable = true,
      customBaseUrl,
      customModelId,
      capabilities,
      inspectionFailed,
      cloud,
    } = options;
    modelsMock.mockResolvedValue({
      reachable,
      models: models.map((name) => ({ name, capabilities })),
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
    const validate = provider.auth[0].validateNonInteractive;
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

  it("rejects an ollama.com base URL before destructive reset", async () => {
    modelsMock.mockResolvedValue({ reachable: true, models: [{ name: "kimi-k3" }] });
    const ctx = resetContext({ customBaseUrl: "https://ollama.com", customModelId: "kimi-k3" });
    const validate = provider.auth[0].validateNonInteractive;

    await expect(validate(ctx)).rejects.toThrow("--auth-choice ollama-cloud");
    expect(modelsMock).not.toHaveBeenCalled();
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
    const prompter = {} as never;
    const result = await provider.auth[0].run({
      config: {},
      prompter,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });
    expect(result).toEqual({
      configPatch: setupConfig(),
      profiles: [],
      defaultModel: "ollama/qwen-tool",
    });
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
    mockInstalledModels({ "unknown-tools": undefined, "qwen-tool": true }, 4_000_000_000);
    await expect(guided?.detect({ config: {}, env: {} })).resolves.toEqual({
      modelRef: "ollama/qwen-tool",
      detail: "qwen-tool at http://127.0.0.1:11434",
    });
    const prepared = await prepareGuided();
    expect(prepared).toMatchObject({
      profiles: [],
      defaultModel: "ollama/qwen-tool",
      configPatch: ollamaConfig({
        baseUrl: localBaseUrl,
        api: "ollama",
        models: [{ id: "qwen-tool" }],
        apiKey: OLLAMA_DEFAULT_API_KEY,
      }),
    });
    expect(prepared?.configPatch?.models?.mode).toBe("merge");
    expect(prepared?.configPatch?.models?.providers?.ollama?.models?.[0]).not.toHaveProperty(
      "parameterCount",
    );
    await expect(prepareGuided("ollama/unknown-tools")).resolves.toBeNull();
    loadedMock.mockResolvedValue({ reachable: true, models: [] });
    await expect(prepareGuided()).resolves.toBeNull();
    expect(modelsMock).toHaveBeenCalledTimes(3);
    expect(pullMock).not.toHaveBeenCalled();
  });

  it("uses the Docker host default for availability detection during Docker setup", async () => {
    modelsMock.mockResolvedValue({ reachable: true, models: [] });
    await guided?.detectAvailability?.({
      config: {},
      env: { OPENCLAW_DOCKER_SETUP: "1" },
    });
    expect(modelsMock).toHaveBeenCalledWith("http://host.docker.internal:11434", {});
  });

  it("does not auto-detect installed models that are not loaded", async () => {
    loadedMock.mockResolvedValue({ reachable: true, models: [] });
    await expect(guided?.detect({ config: {}, env: {} })).resolves.toBeNull();
    expect(discoveryMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
  });

  it.each(["literal", "SecretRef", "ambient"] as const)(
    "prepares the requested model with its runtime context and %s credential",
    async (credential) => {
      const ambient = credential === "ambient";
      const baseUrl = ambient ? "https://ollama.example.com" : "https://ollama.com.example/v1";
      const model = {
        ...createModel("qwen-tool", "qwen-tool", { contextWindow: 32_768 }),
        compat: { supportsTools: true },
      };
      const config = ollamaConfig({
        baseUrl,
        apiKey:
          credential === "literal"
            ? "fixture-access"
            : credential === "SecretRef"
              ? { source: "env" as const, provider: "default", id: "OLLAMA_SETUP_TEST_KEY" }
              : undefined,
        api: "ollama" as const,
        models: ambient ? [] : [model],
      });
      if (!ambient) {
        loadedMock.mockResolvedValue({ reachable: true, models: [] });
      }
      mockInstalledModels({ "qwen-tool": true });
      mockShow(["completion", "tools"], 262_144);
      const result = await prepareGuided("ollama/qwen-tool", config, {
        OLLAMA_SETUP_TEST_KEY: "fixture-access",
        ...(ambient ? { OLLAMA_API_KEY: "fixture-access" } : {}),
      });
      expect(result).toMatchObject({
        defaultModel: "ollama/qwen-tool",
        configPatch: ollamaConfig({
          models: [expect.objectContaining({ id: "qwen-tool" })],
        }),
      });
      const prepared = result?.configPatch?.models?.providers?.ollama?.models?.[0];
      expect(prepared).toMatchObject({ contextWindow: 262_144, contextTokens: 32_768 });
      expectShowKey(baseUrl.replace(/\/v1$/, ""), "qwen-tool", "fixture-access");
      if (ambient) {
        expect(modelsMock).toHaveBeenCalledWith(
          baseUrl,
          expect.objectContaining({ apiKey: "fixture-access" }),
        );
        expect(result?.configPatch?.models?.providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
      } else {
        expect(loadedMock).not.toHaveBeenCalled();
      }
    },
  );

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

  it("does not send the ambient Ollama cloud key to automatic localhost discovery", async () => {
    mockInstalledModels({ "qwen-tool": true });
    await guided?.detect({
      config: {},
      env: { OLLAMA_API_KEY: "cloud-access" },
    });
    const options = modelsMock.mock.calls.at(-1)?.[1] as
      | { apiKey?: string; quiet?: boolean }
      | undefined;
    expect(options?.apiKey).toBeUndefined();
    expect(loadedMock).toHaveBeenCalledWith(localBaseUrl, {});
  });

  it("honors the Ollama discovery opt-out during app-guided detection", async () => {
    const context = { config: discoveryConfig(false), env: {} };
    await expect(guided?.detect(context)).resolves.toBeNull();
    await expect(guided?.detectAvailability?.(context)).resolves.toBe(false);
    expect(loadedMock).not.toHaveBeenCalled();
    expect(discoveryMock).not.toHaveBeenCalled();
    expect(modelsMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses live discovery enabled=%s after startup disable",
    async (enabled) => {
      mockDiscovery([{ id: "llama3.2", name: "Llama 3.2" }]);
      const result = await runCatalog(
        registerProvider({ discovery: { enabled: false } }),
        enabled
          ? { apiKey: "profile-key", discoveryApiKey: "profile-key" }
          : { apiKey: "", discoveryApiKey: "" },
        discoveryConfig(enabled),
        { OLLAMA_API_KEY: "cloud-key" },
      );
      if (!enabled) {
        expect(result).toBeNull();
        expect(discoveryMock).not.toHaveBeenCalled();
        return;
      }
      expect(discoveryMock).toHaveBeenCalledOnce();
      expect(discoveryMock).toHaveBeenCalledWith(undefined, {
        onListedModels: expect.any(Function),
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
    },
  );

  it("preserves explicit api for configured dynamic Ollama models", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "ollama-live");
    mockDiscovery(
      [createModel("qwen3-coder:cloud", "qwen3-coder:cloud")],
      "https://ollama.example.com",
    );
    const config = ollamaConfig({
      baseUrl: "https://ollama.example.com/v1",
      api: "openai-completions",
      models: [],
    });
    expect(await prepareDynamic("qwen3-coder:cloud", config)).toMatchObject({
      provider: "ollama",
      id: "qwen3-coder:cloud",
      api: "openai-completions",
      baseUrl: "https://ollama.example.com/v1",
    });
    expectDiscoveryKey("https://ollama.example.com/v1", "ollama-live");
  });

  it("returns the exact prepared Ollama model for concurrent credential profiles", async () => {
    const baseUrl = "https://shared-dynamic-ollama.example.com";
    const modelId = "tenant-dynamic-model";
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
      prepareDynamic(modelId, dynamicConfig(baseUrl, apiKey), authProfileId);
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
    expectDiscoveryKey(baseUrl, "first-tenant-access");
    expectDiscoveryKey(baseUrl, "second-tenant-access", 2);
  });

  it("preserves opaque environment-backed SecretRef value OLLAMA_API_KEY for dynamic discovery", async () => {
    const secretValue = "OLLAMA_API_KEY";
    const baseUrl = "https://secretref-dynamic-ollama.example.com";
    const envId = "VITEST_OLLAMA_DYNAMIC_DISCOVERY_KEY";
    vi.stubEnv(envId, secretValue);
    const config = dynamicConfig(baseUrl, { source: "env", provider: "default", id: envId });
    mockDiscovery([], baseUrl);
    const resolved = await prepareDynamic("secretref-dynamic-model", config);
    expect(resolved?.id).toBe("secretref-dynamic-model");
    expectDiscoveryKey(baseUrl, secretValue);
    expectShowKey(baseUrl, "secretref-dynamic-model", secretValue);
  });

  it("keeps rotated managed SecretRefs request-owned and fails closed when unavailable", async () => {
    const baseUrl = "https://managed-dynamic-ollama.example.com";
    const modelId = "managed-private-model";
    const config = dynamicConfig(baseUrl, {
      source: "file",
      provider: "default",
      id: "/ollama/apiKey",
    });
    secretMock
      .mockResolvedValueOnce({ value: "managed-dynamic-access" })
      .mockResolvedValueOnce({ value: "rotated-managed-access" })
      .mockResolvedValueOnce({ unresolvedRefReason: "managed credential is unavailable" });
    mockDiscovery([{ id: modelId, name: "Managed private model", contextWindow: 8192 }], baseUrl);
    mockDiscovery([{ id: modelId, name: "Rotated managed model", contextWindow: 8192 }], baseUrl);
    await expect(prepareDynamic(modelId, config)).resolves.toMatchObject({
      id: modelId,
      name: "Managed private model",
    });
    await expect(prepareDynamic(modelId, config)).resolves.toMatchObject({
      id: modelId,
      name: "Rotated managed model",
    });
    await expect(prepareDynamic(modelId, config)).resolves.toBeUndefined();
    expectDiscoveryKey(baseUrl, "rotated-managed-access", 2);
    expect(discoveryMock).toHaveBeenCalledTimes(2);
  });

  it("reconciles configured refs and incomplete catalog rows without probing complete rows", async () => {
    showMock.mockResolvedValue({
      ...showInfo(["completion", "tools", "thinking", "vision"], 1_048_576),
      parameterCount: 4_000_000_000,
    });
    const rows = await augmentCatalog(provider, {
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
          parameterCount: 70_000_000_000,
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
          parameterCount: 4_000_000_000,
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
    mockShow(entry.capabilities);
    const rows = await augmentCatalog(
      entry.providerId === "ollama" ? provider : registerOllamaCloudProvider(),
      {
        config: {
          ...configuredRefs(`${entry.providerId}/${entry.modelId}`),
          ...(entry.baseUrl
            ? ollamaConfig({ baseUrl: entry.baseUrl, api: "ollama", apiKey: entry.configuredKey })
            : {}),
        },
        env: entry.env,
        resolveProviderApiKey: () => entry.resolved,
      },
    );
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
    const rows = await augmentCatalog(registerOllamaCloudProvider(), {
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
    let active = 0;
    let maxActive = 0;
    showMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return showInfo(["completion", "thinking"], 1_048_576);
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
    vi.stubEnv("OLLAMA_API_KEY", "ollama-local");
    mockDiscovery([]);
    showMock.mockResolvedValueOnce({ showInspectionFailed: true });
    await expect(prepareDynamic("depseek-v4-pro:cloud")).resolves.toBeUndefined();
  });

  it("retains a requested model's declared size when show has no other metadata", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "ollama-local");
    mockDiscovery([]);
    showMock.mockResolvedValueOnce({ parameterCount: 70_000_000_000 });
    await expect(prepareDynamic("custom-4b")).resolves.toMatchObject({
      id: "custom-4b",
      parameterCount: 70_000_000_000,
    });
  });

  it.each([
    ["remote", "ollama-cloud", cloudBaseUrl, "kimi-k2.6", "Kimi K2.6"],
    [
      "mapped loopback",
      "ollama-alt-local",
      "http://[::ffff:7f00:2]:11434",
      "llama3.2",
      "Llama 3.2",
    ],
  ])(
    "resolves implicit discovery with a custom %s provider",
    async (name, providerId, baseUrl, model, modelName) => {
      mockDiscovery([]);
      const result = await runCatalog(
        provider,
        { apiKey: "ollama-live" },
        createModelProviderConfig({
          [providerId]: {
            api: "ollama",
            baseUrl,
            models: [createModel(model, modelName)],
          },
        }),
        { NODE_ENV: "development", OLLAMA_API_KEY: "ollama-live" },
      );
      if (name === "remote") {
        expect(result).toBeNull();
        expect(discoveryMock).not.toHaveBeenCalled();
      } else {
        expect(result?.provider.baseUrl).toBe(localBaseUrl);
      }
    },
  );

  it.each([false, true])("mints synthetic auth only for a non-default alias: %s", async (alias) => {
    const providerConfig = {
      api: "ollama",
      models: [],
      ...(alias ? { baseURL: "http://remote-ollama:11434" } : { baseUrl: localBaseUrl }),
    };
    const auth = provider.resolveSyntheticAuth?.({ providerConfig });
    if (alias) {
      expect(auth).toEqual({
        apiKey: "ollama-local",
        source: "models.providers.ollama (synthetic local key)",
        mode: "api-key",
      });
    } else {
      expect(auth).toBeUndefined();
      await expect(
        runCatalog(provider, { apiKey: "" }, ollamaConfig(providerConfig)),
      ).resolves.toBeNull();
      expect(discoveryMock).not.toHaveBeenCalled();
    }
  });

  it.each([true, false])(
    "authenticates cloud catalog discovery with GLM-5.2 listed=%s",
    async (listed) => {
      mockDiscovery([buildOllamaModelDefinition(listed ? "glm-5.2" : "kimi-k2.6")], cloudBaseUrl);
      if (!listed) {
        mockShow(["completion", "thinking", "tools"], 1_000_000);
      }
      const result = await runCatalog(
        registerOllamaCloudProvider(),
        {
          apiKey: listed ? "OLLAMA_API_KEY" : "secretref-managed",
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
      if (listed) {
        expect(result?.provider.apiKey).toBe("OLLAMA_API_KEY");
        expect(result?.provider.models).toContainEqual(
          expect.objectContaining({ id: "glm-5.2", name: "glm-5.2" }),
        );
        return;
      }
      expectShowKey(cloudBaseUrl, "glm-5.2", "cloud-key");
      expect(result?.provider.models).toContainEqual(
        expect.objectContaining({
          id: "glm-5.2",
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoning: true,
        }),
      );
    },
  );

  it("lists and resolves GLM-5.2 from the offline cloud catalog", async () => {
    const cloud = registerOllamaCloudProvider();
    const catalog = await cloud.staticCatalog.run({});
    expect(catalog.provider.models).toContainEqual(expect.objectContaining({ id: "glm-5.2" }));
    const model = cloud.resolveDynamicModel?.({
      provider: "ollama-cloud",
      modelId: "glm-5.2",
    } as never);
    expect(model).toMatchObject({
      provider: "ollama-cloud",
      id: "glm-5.2",
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      reasoning: true,
    });
    expect(model?.contextTokens).toBeUndefined();
  });

  it("wraps OpenAI-compatible payloads with num_ctx for Ollama compat routes", async () => {
    const payloadResult = Promise.resolve();
    const onPayload = vi.fn((payload: unknown) => {
      expect(payload).toEqual({ options: { temperature: 0.1, num_ctx: 32_768 } });
      return payloadResult;
    });
    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      const payload: Record<string, unknown> = { options: { temperature: 0.1 } };
      await expect(options?.onPayload?.(payload, _model)).resolves.toBeUndefined();
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
    await wrapped({} as never, { messages: [] }, { onPayload });
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(onPayload).toHaveBeenCalledOnce();
  });

  it("does not start the ollama stream after cancellation during wrapper preparation", async () => {
    const controller = new AbortController();
    const reason = new Error("stream canceled during preparation");
    const baseStreamFn = vi.fn(() => ({}) as never);
    const model = {
      api: "ollama",
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
    const streamFn = vi.fn(() => ({}) as never);
    const context = { provider: "ollama", modelId: "qwen3:32b" };
    expect(provider.wrapStreamFn?.({ ...context, streamFn })).toBe(streamFn);
    expect(provider.wrapStreamFn?.(context)).toBeUndefined();
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("selects cloud native transport with the default URL only for api=ollama", () => {
    const cloud = registerOllamaCloudProvider();
    const createStream = (api: "ollama" | "openai-completions") =>
      cloud.createStreamFn?.({
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
    provider.createStreamFn?.({
      config: createModelProviderConfig({
        "Ollama-GPU": { api: "ollama", baseURL: "http://127.0.0.1:11435", models: [] },
      }),
      model: { id: "llama3.2", provider: "ollama-gpu", api: "ollama" },
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
