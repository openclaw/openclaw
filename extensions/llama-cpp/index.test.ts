import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import type {
  OpenClawPluginApi,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
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
const runtimeFacts = {
  buildInfo: "b10357 (689e227db)",
  endpoints: { health: "ready", metrics: "ready" },
};
const { create: createEmbedding, resolveIndexIdentity } = llamaCppEmbeddingProviderAdapter;
let fixture: ReturnType<typeof createFixture>;

beforeEach(() => {
  fixture = createFixture();
  mocks.detectHardware.mockReset();
  mocks.discoverServer.mockReset();
  mocks.ensureModel.mockResolvedValue("/models/model.gguf");
  mocks.ensureRuntime.mockResolvedValue({ command: "/runtime/llama-server" });
  mocks.ensureChat.mockResolvedValue(undefined);
  mocks.prepareServer.mockResolvedValue({});
  mocks.inspectRuntime.mockResolvedValue(runtimeFacts);
  mocks.genericCreate.mockResolvedValue(embeddingResult([0.6, 0.8], [[0.3, 0.4]]));
});

afterEach(() => vi.clearAllMocks());

function registerTextProvider() {
  const { api, providers } = createCapturedPluginRegistration({ id: PROVIDER_ID });
  llamaCppPlugin.register(api);
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

function embeddingResult(vector: number[], batch: number[][]) {
  return {
    provider: {
      embed: async () => vector,
      embedBatch: async () => batch,
    },
  };
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
    const { model } = fixture;
    model.reasoning = true;
    model.compat = { supportsReasoningEffort: true, supportsJsonSchemaResponseFormat: true };
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    let reasoning: "off" | "max" | undefined;
    const inner = vi.fn<StreamFn>(async (requestModel, context, options) => {
      const request = buildParams({ ...requestModel, api: "openai-completions" }, context, options);
      const payload = (await options?.onPayload?.(request, requestModel)) ?? request;
      expect(payload).toMatchObject({ response_format: { type: "json_object", schema } });
      if (reasoning === "off") {
        expect(payload).toHaveProperty("chat_template_kwargs.enable_thinking", false);
      } else {
        expect(payload).not.toHaveProperty("chat_template_kwargs");
        expect(payload).toHaveProperty("reasoning_effort", "high");
      }
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    });
    const wrapped = wrapChat("wrapStreamFn", {}, model, inner);
    for (reasoning of ["off", "max", undefined] as const) {
      const options = { responseFormat: schema, ...(reasoning ? { reasoning } : {}) };
      await wrapped(model, { messages: [] }, options);
    }
    expect(inner).toHaveBeenCalledTimes(3);
    expect(mocks.ensureChat).not.toHaveBeenCalled();
  });

  it("keeps an embedding-only managed model inventory empty", async () => {
    const catalog = expectDefined(registerTextProvider().catalog, "managed model catalog");
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
    "routes managed embeddings and preserves media residency (%s)",
    async (modelPath) => {
      const { providerConfig } = fixture;
      providerConfig.params = { mediaModels: { ocr: "ocr", vision: "vision" } };
      providerConfig.localService?.args?.push("--models-max", "1");
      if (modelPath) {
        fixture.providerConfig.models = [];
      }
      const result = await createEmbedding({ ...fixture.options, local: { modelPath } });
      expectCall(mocks.prepareServer, {
        chatModel: { mode: "preserve" },
        configuredChatModelIds: modelPath ? [] : ["gemma-4-e4b-it-q4_k_m"],
        mediaModels: [],
        localService: providerConfig.localService,
        embeddingModelPath: "/models/model.gguf",
      });
      expect(result.runtime?.cacheKeyData).toEqual({
        provider: "local",
        model: modelPath ?? DEFAULT_MODEL,
      });
      expectCall(mocks.ensureModel, { source: modelPath ?? DEFAULT_MODEL, download: true });
      const provider = expectDefined(result.provider, "local embedding provider");
      expect(provider.maxInputTokens).toBe(2044);
      await expect(provider.embed("hello")).resolves.toEqual([0.6, 0.8]);
      const readFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
      expect(readFacts()).toMatchObject(runtimeFacts);
    },
  );

  it.each([
    { dimensions: undefined, expected: [3 / 13, 4 / 13, 12 / 13] },
    { dimensions: 2, expected: [0.6, 0.8] },
  ])("projects local vectors to $dimensions dimensions", async ({ dimensions, expected }) => {
    const vector = [3, 4, 12];
    mocks.genericCreate.mockResolvedValueOnce(embeddingResult(vector, [vector, vector]));
    const result = await createEmbedding({ ...fixture.options, dimensions });
    const provider = expectDefined(result.provider, "local embedding provider");

    await expect(provider.embed("query")).resolves.toEqual(expected);
    await expect(provider.embedBatch(["first", "second"])).resolves.toEqual([expected, expected]);
    expect(provider.dimensions).toBe(dimensions);
    const cacheKeyData = expectDefined(result.runtime?.cacheKeyData, "embedding cache key data");
    expect(cacheKeyData.outputDimensionality).toBe(dimensions);
  });

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

  it("reapplies embedding A to B to A and injects preset reconciliation", async () => {
    const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
    const options = { ...fixture.options, acquireLocalService };
    const provider = fixture.providerConfig;
    provider.baseUrl = "http://127.0.0.1:29434/v1";
    provider.params = { modelCacheDir: "/models/embedding-transition-cache" };
    mocks.ensureModel.mockImplementation(async ({ source }) => source);
    const sequence = ["/models/a.gguf", "/models/b.gguf", "/models/a.gguf"];
    for (const modelPath of sequence) {
      await createEmbedding({ ...options, local: { modelPath } });
    }
    expect(mocks.prepareServer.mock.calls.map(([call]) => call.embeddingModelPath)).toEqual(
      sequence,
    );
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

  it("prepares chat before transport independently of an active custom embedding model", async () => {
    const { config: configured, model } = fixture;
    const search = {
      enabled: true,
      provider: "local" as const,
      local: { modelPath: "hf:retired-org/removed-embedding-model-GGUF/embedding.gguf" },
    };
    const config = { ...configured, memory: { search } };
    const order: string[] = [];
    mocks.ensureChat.mockImplementation(async () => {
      order.push("prepare");
    });
    const inner = vi.fn(() => {
      order.push("transport");
      return {} as never;
    });
    for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
      await wrapChat(hook, config, model, inner)({} as never, { messages: [] }, {});
    }
    expect(order).toEqual(["prepare", "transport", "prepare", "transport"]);
  });

  it("keeps registered text setup chat-capable when local memory is enabled", async () => {
    const method = expectDefined(registerTextProvider().auth[0], "llama.cpp setup method");
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
    const aliases = [
      path.join(modelCacheDir, CACHE_FILE),
      path.join(resolveLegacyLlamaCppModelCacheDir(), CACHE_FILE),
      CACHE_FILE,
    ].map((alias) => expect.objectContaining({ model: alias }));
    const identity = resolveIndexIdentity?.({
      ...fixture.options,
      config: custom ? {} : fixture.config,
      model,
      local: { modelPath },
      ...(custom ? { dimensions: 512 } : {}),
    });
    expect(identity).toEqual({
      model,
      cacheKeyData: { provider: "local", model, ...(custom ? { outputDimensionality: 512 } : {}) },
      aliases: custom ? [] : expect.arrayContaining(aliases),
    });
  });
});
