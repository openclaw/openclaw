import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawConfig,
  ProviderAuthMethod,
  ProviderPrepareDynamicModelContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER } from "./src/defaults.js";

const fetchLmstudioModelsMock = vi.hoisted(() => vi.fn());
const discoverLmstudioModelsMock = vi.hoisted(() =>
  vi.fn<typeof import("./src/models.fetch.js").discoverLmstudioModels>(),
);
const baseUrl = "http://lmstudio.internal:1234/v1";
const modelId = "qwen/qwen3.5-9b";

vi.mock("./src/models.fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/models.fetch.js")>()),
  fetchLmstudioModels: fetchLmstudioModelsMock,
  discoverLmstudioModels: discoverLmstudioModelsMock,
}));

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected the LM Studio plugin hook to be registered");
  }
  return value;
}

function resetContext(
  opts: Record<string, unknown> = {},
  resolvedApiKey: { key: string; source: "flag" | "env" | "profile" } | null = null,
): Parameters<NonNullable<ProviderAuthMethod["validateNonInteractive"]>>[0] {
  return {
    authChoice: "lmstudio",
    config: {},
    baseConfig: {},
    opts: { customBaseUrl: baseUrl, ...opts },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
    resolveApiKey: vi.fn(async () => resolvedApiKey),
  };
}

function makeProvider(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl,
    models: [model("Qwen 3.5 9B", 131072, modelId)],
    ...overrides,
  };
}

function configuredModels(models: unknown): OpenClawConfig {
  return { models: { providers: { lmstudio: { models } } } } as unknown as OpenClawConfig;
}

function withProvider(lmstudio = makeProvider()): OpenClawConfig {
  return { models: { mode: "merge", providers: { lmstudio } } };
}

function mockReachableModels(models: ReturnType<typeof loadedModel>[] = []) {
  fetchLmstudioModelsMock.mockResolvedValue({ reachable: true, status: 200, models });
}

function expectFetch(apiKey: string, url = baseUrl) {
  expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({ baseUrl: url, apiKey, timeoutMs: 5000 });
}

function loadedModel(key: string, id = key) {
  return { type: "llm", key, loaded_instances: [{ id, config: { context_length: 32_768 } }] };
}

function dynamicContext(profile: "first" | "second"): ProviderPrepareDynamicModelContext {
  return {
    provider: "lmstudio",
    modelId: "shared-model",
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
    authProfileId: `lmstudio:${profile}`,
    providerConfig: { baseUrl, headers: { Authorization: `Bearer ${profile}-profile` } },
  };
}

function model(name: string, contextWindow: number, id = "shared-model"): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8192,
  };
}

describe("lmstudio plugin", () => {
  let provider: ReturnType<typeof capturePluginRegistration>["providers"][number];
  const syntheticAuth = (providerConfig?: ModelProviderConfig) =>
    provider.resolveSyntheticAuth?.({ provider: "lmstudio", config: {}, providerConfig });
  beforeEach(() => {
    fetchLmstudioModelsMock.mockReset();
    discoverLmstudioModelsMock.mockReset();
    provider = required(capturePluginRegistration(plugin).providers[0]);
    expect(provider.id).toBe("lmstudio");
  });

  it("prepares a supplied setup key and requested loaded model without prompts or auth-store writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lmstudio-supplied-auth-"));
    const agentDir = path.join(root, "agent");
    const config = withProvider();
    const before = structuredClone(config);
    const { prompter, text, confirm } = createQueuedWizardPrompter();
    mockReachableModels([loadedModel(modelId, "qwen")]);
    try {
      const result = await required(provider.auth[0]).run({
        config,
        agentDir,
        prompter,
        runtime: createNonExitingRuntimeEnv(),
        opts: {
          tokenProvider: "lmstudio",
          token: "supplied-lmstudio-key",
          customModelId: modelId,
        },
        isRemote: true,
        openUrl: vi.fn(),
        oauth: { createVpsAwareHandlers: vi.fn() },
      });
      expect(result).toMatchObject({
        profiles: [
          {
            profileId: "lmstudio:default",
            credential: { type: "api_key", provider: "lmstudio", key: "supplied-lmstudio-key" },
          },
        ],
        defaultModel: "lmstudio/qwen/qwen3.5-9b",
        configPatch: { models: { providers: { lmstudio: { baseUrl } } } },
      });
      expectFetch("supplied-lmstudio-key");
      expect(text).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(config).toEqual(before);
      await expect(fs.access(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps concurrent model preparations isolated when shared-endpoint profiles finish in reverse order", async () => {
    const prepareDynamicModel = required(provider.prepareDynamicModel);
    const firstDiscovery = createDeferred<ModelDefinitionConfig[]>();
    const secondDiscovery = createDeferred<ModelDefinitionConfig[]>();
    discoverLmstudioModelsMock.mockImplementation(({ headers }) =>
      headers?.Authorization === "Bearer first-profile"
        ? firstDiscovery.promise
        : secondDiscovery.promise,
    );
    const firstPreparation = prepareDynamicModel(dynamicContext("first"));
    const secondPreparation = prepareDynamicModel(dynamicContext("second"));
    await vi.waitFor(() => expect(discoverLmstudioModelsMock).toHaveBeenCalledTimes(2));
    secondDiscovery.resolve([model("Second profile model", 65_536)]);
    const secondPrepared = await secondPreparation;
    firstDiscovery.resolve([model("First profile model", 32_768)]);
    const firstPrepared = await firstPreparation;
    expect([secondPrepared, firstPrepared]).toMatchObject([
      { id: "shared-model", name: "Second profile model", contextWindow: 65_536 },
      { id: "shared-model", name: "First profile model", contextWindow: 32_768 },
    ]);
  });

  it("returns only the requested discovered model without retaining stale endpoint results", async () => {
    const prepareDynamicModel = required(provider.prepareDynamicModel);
    const otherModel = model("Other model", 16_384, "other-model");
    const requestedModel = model("Requested model", 32_768);
    discoverLmstudioModelsMock
      .mockResolvedValueOnce([otherModel, requestedModel])
      .mockResolvedValueOnce([otherModel]);
    const context = dynamicContext("first");
    await expect(prepareDynamicModel(context)).resolves.toMatchObject({
      ...requestedModel,
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl,
    });
    await expect(prepareDynamicModel(context)).resolves.toBeUndefined();
    expect(discoverLmstudioModelsMock).toHaveBeenCalledWith({
      baseUrl,
      apiKey: "",
      headers: { Authorization: "Bearer first-profile" },
      quiet: true,
    });
  });

  it.each([
    { mode: "local", baseUrl: "http://localhost:1234/v1" },
    { mode: "docker", baseUrl: "http://host.docker.internal:1234/v1" },
    { mode: "configured", baseUrl },
  ])("detects a reachable $mode service without loaded models", async ({ mode, baseUrl: url }) => {
    mockReachableModels();
    const config: OpenClawConfig =
      mode === "configured"
        ? withProvider(makeProvider({ baseUrl: url.replace("/v1", "/api/v1/"), models: [] }))
        : {};
    await expect(
      required(provider.auth[0]?.appGuidedSetup?.detectAvailability)({
        config,
        env: mode === "docker" ? { OPENCLAW_DOCKER_SETUP: "1" } : {},
      }),
    ).resolves.toBe(true);
    expectFetch(LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, url);
  });

  it("uses the provider-specific API key for read-only reset discovery", async () => {
    mockReachableModels([loadedModel(modelId)]);
    const ctx = resetContext(
      {
        customModelId: modelId,
        lmstudioApiKey: "lmstudio-test-key",
        customApiKey: "custom-test-key",
      },
      { key: "lmstudio-test-key", source: "flag" },
    );
    await expect(required(provider.auth[0]?.validateNonInteractive)(ctx)).resolves.toBe(true);
    expect(ctx.resolveApiKey).toHaveBeenCalledWith({
      provider: "lmstudio",
      flagValue: "lmstudio-test-key",
      flagName: "--lmstudio-api-key",
      envVar: "LM_API_TOKEN",
      envVarName: "LM_API_TOKEN",
      required: false,
    });
    expectFetch("lmstudio-test-key");
  });

  it.each`
    failure                       | reachable | status | models                                                   | customModelId | message
    ${"unreachable endpoint"}     | ${false}  | ${200} | ${[]}                                                    | ${undefined}  | ${`LM Studio could not be reached at ${baseUrl}.\nStart LM Studio (or run lms server start) and re-run setup.`}
    ${"HTTP 401"}                 | ${true}   | ${401} | ${[]}                                                    | ${undefined}  | ${`LM Studio returned HTTP 401 while listing models at ${baseUrl}.\nCheck the base URL and API key, then re-run setup.`}
    ${"HTTP 503"}                 | ${true}   | ${503} | ${[]}                                                    | ${undefined}  | ${`LM Studio returned HTTP 503 while listing models at ${baseUrl}.\nCheck the base URL and API key, then re-run setup.`}
    ${"missing requested model"}  | ${true}   | ${200} | ${[loadedModel("phi-4")]}                                | ${modelId}    | ${`LM Studio model ${modelId} was not found at ${baseUrl}.\nAvailable models: phi-4`}
    ${"no usable LLM"}            | ${true}   | ${200} | ${[{ type: "embedding", key: "text-embedding-nomic" }]}  | ${undefined}  | ${`No loaded LM Studio LLM models were found at ${baseUrl}.\nLoad a model in LM Studio (or run lms load <model>), then re-run setup.`}
    ${"unloaded requested model"} | ${true}   | ${200} | ${[{ type: "llm", key: modelId, loaded_instances: [] }]} | ${modelId}    | ${`LM Studio model ${modelId} is installed but not loaded at ${baseUrl}.\nLoad that model in LM Studio, then re-run setup.`}
  `(
    "rejects $failure before destructive reset",
    async ({ models, message, reachable, status, customModelId }) => {
      fetchLmstudioModelsMock.mockResolvedValue({ reachable, status, models });
      const ctx = resetContext({ customModelId });
      await expect(required(provider.auth[0]?.validateNonInteractive)(ctx)).rejects.toThrow(
        message,
      );
      expect(ctx.runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    makeProvider({ models: [], headers: { Authorization: "Bearer proxy-token" } }),
    makeProvider({ models: [], apiKey: "synthetic-test-key" }),
  ])("does not synthesize auth without opt-in or over credentials: %j", (providerConfig) => {
    expect(syntheticAuth(providerConfig)).toBeUndefined();
  });

  it("acquires the live catalog with saved model rows", async () => {
    const config = withProvider();
    const before = structuredClone(config);
    const models = [model("Live model", 65_536, modelId), model("New model", 32_768, "new-model")];
    discoverLmstudioModelsMock.mockResolvedValue(models);
    const result = await provider.catalog?.run({
      config,
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });
    expect(result).toMatchObject({
      provider: { models },
      outcomes: [{ provider: "lmstudio", status: "ready" }],
    });
    expect(config).toEqual(before);
  });

  it("defers stored lmstudio-local profile auth so real credentials can win", () => {
    const shouldDefer = (resolvedApiKey: string) =>
      provider.shouldDeferSyntheticProfileAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: makeProvider(),
        resolvedApiKey,
      });
    expect(shouldDefer(LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER)).toBe(true);
    expect(shouldDefer(CUSTOM_LOCAL_AUTH_MARKER)).toBe(true);
    expect(shouldDefer("lmstudio-real-key")).toBe(false);
  });

  it("augments the catalog with configured lmstudio models", () => {
    const compactModel = {
      id: "compact-chat",
      name: "Compact Chat",
      parameterCount: 4_000_000_000,
      contextWindow: 32768,
      contextTokens: 8192,
      reasoning: true,
      input: ["text", "image"],
      compat: {
        codeMode: "preferred",
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["off", "on"],
        reasoningEffortMap: { off: "off", high: "on" },
      },
    };
    const config = configuredModels([
      compactModel,
      { id: "phi-4", compat: { codeMode: "capable" } },
      { id: "fractional-window", contextWindow: 4096.5 },
      { id: " ", name: "ignored" },
    ]);
    expect(
      provider.augmentModelCatalog?.({
        config,
        agentDir: "/tmp/openclaw",
        env: {},
        entries: [],
      }),
    ).toEqual([
      {
        ...compactModel,
        provider: "lmstudio",
        compat: {
          supportsUsageInStreaming: true,
          codeMode: "preferred",
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
          reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
        },
      },
      ...["phi-4", "fractional-window"].map((id) => ({
        provider: "lmstudio",
        id,
        name: id,
        compat: {
          supportsUsageInStreaming: true,
          ...(id === "phi-4" ? { codeMode: "capable" } : {}),
        },
      })),
    ]);
  });
});
