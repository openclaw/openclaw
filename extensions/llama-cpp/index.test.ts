import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import type {
  OpenClawPluginApi,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearEmbeddingProviders,
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  getRegisteredEmbeddingProvider,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildOpenAICompletionsParams as buildParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverServer: vi.fn(),
  ensureModel: vi.fn(),
  ensureRuntime: vi.fn(),
  ensureChat: vi.fn(),
  prepareServer: vi.fn(),
  reconcileServer: vi.fn(),
  inspectRuntime: vi.fn(),
  genericCreate: vi.fn(),
  detectHardware: vi.fn(),
}));

vi.mock("./src/hardware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/hardware.js")>()),
  detectLlamaCppHardware: mocks.detectHardware,
}));
vi.mock("./src/llama-server-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/llama-server-install.js")>()),
  ensureLlamaServerInstalled: mocks.ensureRuntime,
}));
vi.mock("openclaw/plugin-sdk/embedding-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/embedding-providers")>()),
  getEmbeddingProvider: () => ({ create: mocks.genericCreate }),
}));
vi.mock("./src/managed-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/managed-server.js")>()),
  ensureLlamaCppModel: mocks.ensureModel,
  ensureManagedLlamaServerForChat: mocks.ensureChat,
  prepareManagedLlamaServer: mocks.prepareServer,
  reconcileManagedLlamaServer: mocks.reconcileServer,
}));
vi.mock("./src/managed-server-inspection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/managed-server-inspection.js")>()),
  inspectLlamaServerRuntime: mocks.inspectRuntime,
}));
vi.mock("./src/external-server/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/external-server/discovery.js")>()),
  discoverLlamaServer: mocks.discoverServer,
}));

import llamaCppPlugin from "./index.js";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_CACHE_FILE as CACHE_FILE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL as DEFAULT_MODEL,
  LLAMA_CPP_PROVIDER_ID as PROVIDER_ID,
  resolveLegacyLlamaCppModelCacheDir,
} from "./src/defaults.js";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
const { create: createEmbedding, resolveIndexIdentity } = llamaCppEmbeddingProviderAdapter;
let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;
let fixture: ReturnType<typeof createFixture>;

beforeEach(() => {
  fixture = createFixture();
  previousPluginRegistry = getActivePluginRegistry();
  mocks.detectHardware.mockReset();
  mocks.discoverServer.mockReset();
  mocks.ensureModel.mockResolvedValue("/models/model.gguf");
  mocks.ensureRuntime.mockResolvedValue({ command: "/runtime/llama-server" });
  mocks.ensureChat.mockResolvedValue(undefined);
  mocks.prepareServer.mockResolvedValue({});
  mocks.inspectRuntime.mockResolvedValue({
    buildInfo: "b10357 (689e227db)",
    endpoints: { health: "ready", metrics: "ready" },
  });
  mocks.genericCreate.mockResolvedValue({
    provider: {
      embed: vi.fn(async () => [0.6, 0.8]),
      embedBatch: vi.fn(async () => [[0.3, 0.4]]),
    },
  });
});

afterEach(() => {
  clearEmbeddingProviders();
  setActivePluginRegistry(previousPluginRegistry ?? createEmptyPluginRegistry());
  vi.clearAllMocks();
});

function registerTextProvider(): ProviderPlugin {
  const providers: ProviderPlugin[] = [];
  llamaCppPlugin.register(
    createTestPluginApi({
      id: PROVIDER_ID,
      registerProvider: (provider) => providers.push(provider),
    }),
  );
  expect(providers.map((provider) => provider.id)).toEqual([PROVIDER_ID]);
  return expectDefined(providers[0], "llama.cpp provider");
}

function createFixture() {
  const definition = {
    id: "gemma-4-e4b-it-q4_k_m",
    name: "Gemma 4 E4B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    params: { modelPath: "/models/chat.gguf" },
  } satisfies ModelProviderConfig["models"][number];
  const model: Model = {
    ...definition,
    provider: PROVIDER_ID,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:19432/v1",
  };
  const providerConfig: ModelProviderConfig = {
    api: "openai-completions",
    apiKey: "llama-cpp-local",
    baseUrl: model.baseUrl,
    localService: {
      command: "/runtime/llama-server",
      args: ["--models-preset", "/runtime/models.ini"],
      healthUrl: "http://127.0.0.1:19432/health",
    },
    models: [definition],
  };
  const config = { models: { providers: { [PROVIDER_ID]: providerConfig } } };
  const options = { config, provider: "local", model: DEFAULT_MODEL };
  return { options, config, providerConfig, model };
}

function wrapChat(
  hook: "wrapStreamFn" | "wrapSimpleCompletionStreamFn",
  config: ProviderWrapStreamFnContext["config"],
  model: Model,
  streamFn: StreamFn,
) {
  return expectDefined(
    registerTextProvider()[hook]?.({
      config,
      provider: PROVIDER_ID,
      modelId: model.id,
      model,
      streamFn,
      sourceApi: "openai-completions",
    }),
    "wrapped chat transport",
  );
}

function expectCall(mock: ReturnType<typeof vi.fn>, expected: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(expected));
}

describe("llama.cpp provider plugin", () => {
  it("uses the normal OpenAI-compatible text transport", () => {
    const provider = registerTextProvider();
    expect(provider).toMatchObject({
      id: PROVIDER_ID,
      label: "llama.cpp",
      normalizeToolSchemas: expect.any(Function),
      inspectToolSchemas: expect.any(Function),
      reconcileLocalService: expect.any(Function),
    });
    expect(provider.auth.map(({ id, wizard }) => [id, wizard?.choiceId])).toEqual([
      ["local", "llama-cpp"],
      ["existing-server", "llama-cpp-existing-server"],
      ["local-media", undefined],
    ]);
    expect(provider).not.toHaveProperty("createStreamFn");
  });

  it("never discovers external models for a managed local service", async () => {
    const provider = registerTextProvider();
    const prepareDynamicModel = expectDefined(provider.prepareDynamicModel, "dynamic model hook");
    const { config, providerConfig } = fixture;
    await expect(
      prepareDynamicModel({
        config,
        provider: PROVIDER_ID,
        modelId: "gemma-4-e4b-it-q4_k_m",
        modelRegistry: {} as never,
        providerConfig,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.discoverServer).not.toHaveBeenCalled();
  });

  it("normalizes sequential requests through the external stream wrapper", async () => {
    const { model: configured } = fixture;
    const model: Model = {
      ...configured,
      reasoning: true,
      compat: { supportsReasoningEffort: true, supportsJsonSchemaResponseFormat: true },
    };
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const payloads: unknown[] = [];
    const inner = vi.fn<StreamFn>(async (requestModel, context, options) => {
      const request = buildParams({ ...requestModel, api: "openai-completions" }, context, options);
      payloads.push((await options?.onPayload?.(request, requestModel)) ?? request);
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    });
    const wrapped = wrapChat("wrapStreamFn", {}, model, inner);
    const reasoningLevels = ["off", "max", undefined] as const;
    for (const reasoning of reasoningLevels) {
      const options = { responseFormat: schema, ...(reasoning ? { reasoning } : {}) };
      await wrapped(model, { messages: [] }, options);
    }
    for (const [index, reasoning] of reasoningLevels.entries()) {
      const payload = payloads[index];
      expect(payload).toMatchObject({ response_format: { type: "json_object", schema } });
      if (reasoning === "off") {
        expect(payload).toHaveProperty("chat_template_kwargs.enable_thinking", false);
      } else {
        expect(payload).not.toHaveProperty("chat_template_kwargs");
        expect(payload).toHaveProperty("reasoning_effort", "high");
      }
    }
    expect(inner).toHaveBeenCalledTimes(reasoningLevels.length);
    expect(mocks.ensureChat).not.toHaveBeenCalled();
  });

  it("keeps an embedding-only managed model inventory empty", async () => {
    const provider = registerTextProvider();
    const catalog = expectDefined(provider.catalog, "managed model catalog");
    const { config, providerConfig } = fixture;
    providerConfig.models = [];
    const result = await catalog.run({
      config,
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });
    expect(result).toMatchObject({ provider: { models: [] } });
  });

  it("registers local embeddings through the generic provider contract", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerVirtualTestPlugin({
      registry,
      config,
      id: PROVIDER_ID,
      name: "llama.cpp Provider",
      contracts: { embeddingProviders: ["local"] },
      register: llamaCppPlugin.register,
    });
    setActivePluginRegistry(registry.registry);
    expect(getRegisteredEmbeddingProvider("local")).toMatchObject({
      ownerPluginId: PROVIDER_ID,
      adapter: {
        id: "local",
        defaultModel: DEFAULT_MODEL,
        transport: "local",
      },
    });
  });

  it("requires managed setup when local memory retains a remote SecretRef", async () => {
    const search = {
      provider: "local" as const,
      remote: { apiKey: { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" } },
    };
    await expect(
      createEmbedding({ ...fixture.options, config: { memory: { search } } }),
    ).rejects.toThrow("Local embeddings need the managed llama.cpp server config");
    expect(mocks.ensureModel).not.toHaveBeenCalled();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });
  it.each([undefined, "/models/custom-embedding.gguf"])(
    "routes managed embeddings (%s)",
    async (modelPath) => {
      if (modelPath) {
        fixture.providerConfig.models = [];
      }
      const result = await createEmbedding({ ...fixture.options, local: { modelPath } });
      expect(result.runtime?.cacheKeyData).toEqual({
        provider: "local",
        model: modelPath ?? DEFAULT_MODEL,
      });
      if (modelPath) {
        expect(mocks.ensureModel).toHaveBeenCalledTimes(1);
        expectCall(mocks.ensureModel, { source: modelPath, download: true });
        expectCall(mocks.prepareServer, {
          chatModel: { mode: "preserve" },
          embeddingModelPath: "/models/model.gguf",
        });
        return;
      }
      const provider = expectDefined(result.provider, "local embedding provider");
      expect(provider.maxInputTokens).toBe(2044);
      await expect(provider.embed("hello")).resolves.toEqual([0.6, 0.8]);
      expectCall(mocks.genericCreate, {
        provider: PROVIDER_ID,
        model: "embeddinggemma-300m-qat-q8_0",
        remote: undefined,
      });
      const readFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
      expect(typeof readFacts).toBe("function");
      expect(readFacts()).toMatchObject({
        buildInfo: "b10357 (689e227db)",
        endpoints: { health: "ready", metrics: "ready" },
      });
    },
  );

  it.each([
    { dimensions: undefined, expected: [3 / 13, 4 / 13, 12 / 13] },
    { dimensions: 2, expected: [0.6, 0.8] },
    { dimensions: 3, expected: [3 / 13, 4 / 13, 12 / 13] },
  ])(
    "projects and normalizes local vectors with dimensions=$dimensions",
    async ({ dimensions, expected }) => {
      mocks.genericCreate.mockResolvedValueOnce({
        provider: {
          embed: async () => [3, 4, 12],
          embedBatch: async () => [
            [3, 4, 12],
            [3, 4, 12],
          ],
        },
      });
      const result = await createEmbedding({ ...fixture.options, dimensions });
      const provider = expectDefined(result.provider, "local embedding provider");

      await expect(provider.embed("query")).resolves.toEqual(expected);
      await expect(provider.embedBatch(["first", "second"])).resolves.toEqual([expected, expected]);
      expect(provider.dimensions).toBe(dimensions);
      expectCall(mocks.genericCreate, { dimensions: undefined });
      expect(result.runtime?.cacheKeyData).toEqual({
        provider: "local",
        model: DEFAULT_MODEL,
        ...(dimensions === undefined ? {} : { outputDimensionality: dimensions }),
      });
    },
  );

  it("rejects local vectors shorter than the requested dimensions", async () => {
    const result = await createEmbedding({ ...fixture.options, dimensions: 3 });
    const provider = expectDefined(result.provider, "local embedding provider");
    for (const operation of [
      () => provider.embed("query"),
      () => provider.embedBatch(["document"]),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "INVALID_EMBEDDING_RESPONSE",
        expectedDimensions: 3,
        actualDimensions: 2,
        message: expect.stringContaining("reduce or remove memory.search.outputDimensionality"),
      });
    }
  });

  it("keeps media preset sections and residency when refreshing embeddings", async () => {
    const { options, providerConfig: provider } = fixture;
    provider.params = { mediaModels: { ocr: "ocr", vision: "vision" } };
    provider.localService?.args?.push("--models-max", "1");
    await createEmbedding(options);
    expectCall(mocks.prepareServer, {
      chatModel: { mode: "preserve" },
      configuredChatModelIds: expect.arrayContaining(["gemma-4-e4b-it-q4_k_m"]),
      mediaModels: [],
      localService: provider.localService,
    });
  });

  it("reapplies embedding A to B to A and injects preset reconciliation", async () => {
    const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
    const options = { ...fixture.options, acquireLocalService };
    const provider = fixture.providerConfig;
    provider.baseUrl = "http://127.0.0.1:29434/v1";
    provider.params = { modelCacheDir: "/models/embedding-transition-cache" };
    mocks.ensureModel.mockImplementation(async ({ source }) => source);
    for (const modelPath of ["/models/a.gguf", "/models/b.gguf", "/models/a.gguf"]) {
      await createEmbedding({ ...options, local: { modelPath } });
    }
    expect(mocks.prepareServer).toHaveBeenCalledTimes(3);
    expect(mocks.prepareServer.mock.calls.map(([call]) => call.embeddingModelPath)).toEqual([
      "/models/a.gguf",
      "/models/b.gguf",
      "/models/a.gguf",
    ]);
    const forwarded = mocks.genericCreate.mock.calls[0]?.[0] as Pick<
      OpenClawPluginApi["runtime"]["llm"],
      "acquireLocalService"
    >;
    const target = { providerId: PROVIDER_ID, baseUrl: "http://127.0.0.1:19432/v1" };
    await forwarded.acquireLocalService?.(target);
    expect(acquireLocalService).toHaveBeenCalledWith(
      { ...target, reconcile: mocks.reconcileServer },
      undefined,
    );
  });

  it("keeps chat preparation independent from an active custom embedding model", async () => {
    const staleEmbeddingSource = "hf:retired-org/removed-embedding-model-GGUF/embedding.gguf";
    const { config: configured, providerConfig, model } = fixture;
    const search = {
      enabled: true,
      provider: "local" as const,
      local: { modelPath: staleEmbeddingSource },
    };
    const config = { ...configured, memory: { search } };
    const inner = vi.fn(() => ({}) as never);
    for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
      await wrapChat(hook, config, model, inner)({} as never, { messages: [] }, {});
    }
    expect(mocks.ensureChat).toHaveBeenCalledWith({
      provider: providerConfig,
      model: expect.objectContaining({ id: model.id }),
    });
    expect(mocks.ensureChat).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("prepares managed chat before simple-completion transport", async () => {
    const { config, model } = fixture;
    const order: string[] = [];
    mocks.ensureChat.mockImplementationOnce(async () => {
      order.push("prepare");
    });
    const transport = vi.fn(() => {
      order.push("transport");
      return {} as never;
    });
    const wrapped = wrapChat("wrapSimpleCompletionStreamFn", config, model, transport);
    await wrapped({} as never, { messages: [] }, {});
    expect(order).toEqual(["prepare", "transport"]);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("keeps registered text setup chat-capable when local memory is enabled", async () => {
    const provider = registerTextProvider();
    const method = expectDefined(provider.auth[0], "llama.cpp setup method");
    fixture.providerConfig.models = [];
    const config = { ...fixture.config, memory: { search: { provider: "local" as const } } };
    mocks.detectHardware.mockResolvedValue({
      platform: "linux",
      arch: "x64",
      totalMemoryBytes: 16 * 1024 ** 3,
      availableMemoryBytes: 16 * 1024 ** 3,
      availableDiskBytes: 100 * 1024 ** 3,
      availableRuntimeDiskBytes: 100 * 1024 ** 3,
      sharedDisk: true,
      accelerator: { kind: "cpu", reason: "CPU fixture" },
    });
    mocks.ensureModel.mockImplementation(async ({ source, download }) => {
      if (!download) {
        throw new Error("not cached");
      }
      return source.includes("Qwen3.5-9B-GGUF") ? "/models/chat.gguf" : "/models/embedding.gguf";
    });
    const result = await method.run({
      config,
      prompter: {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
      runtime: {},
    } as never);
    expect(result.defaultModel).toBe(`${PROVIDER_ID}/qwen3.5-9b-q4_k_m`);
    expectCall(mocks.prepareServer, {
      chatModel: expect.objectContaining({
        mode: "configure",
        id: "qwen3.5-9b-q4_k_m",
        path: "/models/chat.gguf",
      }),
      embeddingModelPath: "/models/embedding.gguf",
    });
  });

  it.each([false, true])("preserves local index identity (custom=%s)", (custom) => {
    const modelCacheDir = path.join(os.tmpdir(), "managed-llama-models");
    fixture.providerConfig.params = { modelCacheDir };
    const modelPath = custom ? "/models/custom.gguf" : path.join(modelCacheDir, CACHE_FILE);
    const model = custom ? modelPath : DEFAULT_MODEL;
    const identity = resolveIndexIdentity?.({
      ...fixture.options,
      config: custom ? {} : fixture.config,
      model: custom ? modelPath : DEFAULT_MODEL,
      local: { modelPath },
      ...(custom ? { dimensions: 512 } : {}),
    });
    expect(identity).toEqual({
      model,
      cacheKeyData: { provider: "local", model, ...(custom ? { outputDimensionality: 512 } : {}) },
      aliases: custom
        ? []
        : expect.arrayContaining(
            [
              path.join(modelCacheDir, CACHE_FILE),
              path.join(resolveLegacyLlamaCppModelCacheDir(), CACHE_FILE),
              CACHE_FILE,
            ].map((alias) => expect.objectContaining({ model: alias })),
          ),
    });
  });
});
