import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import type { Api, AssistantMessageEventStreamContract, Model, StreamFn } from "@openclaw/llm-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRegistry, type ApiRegistry } from "../api-registry.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";

const vertexStream = vi.fn();
const registerApi = vi.fn();
const resolveStream = vi.fn();
const wrapStream = vi.fn();
const buildStream = vi.fn();
const createStream = vi.fn();
const createTransportStream = vi.fn();
const prepareTransportModel = vi.fn();
const resolveTransportApi = vi.fn();
const inheritManagedTransport = vi.fn((_source: Model, target: Model) => target);
const pluginStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
const TEST_SECRET = "ollama-provider-secret";
const TEST_SECRET_SENTINEL = "test-secret-sentinel";
const initialHost = getAiTransportHost();

function makeModel<T extends Api>(
  overrides: Pick<Model<T>, "api" | "provider" | "baseUrl"> & Partial<Model<T>>,
): Model<T> {
  return makeProviderModel(overrides.api, overrides.provider, "test-model", {
    name: "Test Model",
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 4096,
    ...overrides,
  });
}

function makeChatGPTModel(baseUrl: string) {
  return makeModel({
    id: "gpt-5.5",
    api: "openai-chatgpt-responses",
    provider: "openai",
    baseUrl,
  });
}

// mock-isolation: Exercise simple-completion routing without creating live provider transports.
vi.mock("./provider-transport-stream.js", () => ({
  buildTransportAwareSimpleStreamFn: buildStream,
  createOpenClawTransportStreamFnForModel: createStream,
  createTransportAwareStreamFnForModel: createTransportStream,
  prepareTransportAwareSimpleModel: prepareTransportModel,
  resolveTransportAwareSimpleApi: resolveTransportApi,
}));

let prepareImpl: typeof import("./simple-completion-transport.js").prepareModelForSimpleCompletion;
let apiRegistry: ApiRegistry;

function requireSynchronousStream(
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  if (
    stream instanceof Promise ||
    !("push" in stream) ||
    !("end" in stream) ||
    typeof stream.push !== "function" ||
    typeof stream.end !== "function"
  ) {
    throw new Error("Expected synchronous assistant event stream");
  }
  return stream as AssistantMessageEventStreamContract;
}

function prepare(params: Omit<Parameters<typeof prepareImpl>[0], "apiRegistry">) {
  return prepareImpl({ ...params, apiRegistry });
}

describe("prepareModelForSimpleCompletion", () => {
  beforeAll(async () => {
    // Dynamic import lets the mocked transport/provider modules settle before
    // the unit under test captures custom stream registration helpers.
    ({ prepareModelForSimpleCompletion: prepareImpl } =
      await import("./simple-completion-transport.js"));
  });

  beforeEach(() => {
    apiRegistry = createApiRegistry();
    vertexStream.mockReset().mockReturnValue("vertex-stream");
    registerApi.mockReset();
    registerApi.mockImplementation((registry: ApiRegistry, api: Api, _streamFn: StreamFn) => {
      if (registry.getApiProvider(api)) {
        return false;
      }
      const stream = () => createAssistantMessageEventStream();
      registry.registerApiProvider({ api, stream, streamSimple: stream });
      return true;
    });
    resolveStream.mockReset().mockReturnValue(pluginStreamFn);
    pluginStreamFn.mockClear();
    wrapStream.mockReset();
    buildStream.mockReset();
    createStream.mockReset();
    createTransportStream.mockReset();
    prepareTransportModel.mockReset().mockImplementation((model) => model);
    resolveTransportApi.mockReset();
    inheritManagedTransport.mockClear();
    configureAiTransportHost({
      plugin: {
        resolveProviderStream: resolveStream,
        resolveTransportTurnState: () => undefined,
        wrapSimpleCompletionStream: wrapStream,
        createAnthropicVertexStream: vertexStream,
      },
      registerCustomApi: registerApi,
      inheritManagedTransport,
      resolveSecretSentinel: (value) => value.replaceAll(TEST_SECRET_SENTINEL, TEST_SECRET),
    });
  });

  afterAll(() => configureAiTransportHost(initialHost));

  it("keeps each selected auth and agent policy when completions share a model registry", () => {
    registerApi.mockImplementation((registry: ApiRegistry, api: Api, streamFn: StreamFn) => {
      if (registry.getApiProvider(api)) {
        return false;
      }
      const stream = (...args: Parameters<StreamFn>) => requireSynchronousStream(streamFn(...args));
      registry.registerApiProvider({ api, stream, streamSimple: stream });
      return true;
    });
    wrapStream.mockImplementation(
      ({ context }) =>
        (model: Model, messages: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2]) =>
          context.streamFn(model, messages, {
            ...options,
            headers: {
              "x-test-auth-policy": `${context.auth.mode}:${context.auth.authFlow ?? ""}`,
              "x-test-agent-policy": context.agentId ?? "unscoped",
            },
          }),
    );
    const model = makeModel({
      api: "test-auth-policy",
      provider: "test-provider",
      baseUrl: "https://example.test/v1",
    });
    const prepared = [
      { auth: { mode: "oauth", authFlow: "test-subscription" } },
      { auth: { mode: "oauth", authFlow: "test-identity" } },
      { auth: { mode: "api-key" } },
      { auth: { mode: "api-key" }, agentId: "alpha" },
      { auth: { mode: "api-key" }, agentId: "beta" },
    ].map((selection) => prepare({ model, ...selection }));

    const first = prepared[0];
    if (!first) {
      throw new Error("Expected a prepared model");
    }
    for (const selected of [...prepared, first]) {
      const provider = apiRegistry.getApiProvider(selected.api);
      if (!provider) {
        throw new Error(`Missing registered provider for ${selected.api}`);
      }
      provider.streamSimple(selected, { messages: [] }, {});
    }

    expect(
      pluginStreamFn.mock.calls.map((call) => [
        call[2]?.headers?.["x-test-auth-policy"],
        call[2]?.headers?.["x-test-agent-policy"],
      ]),
    ).toEqual([
      ["oauth:test-subscription", "unscoped"],
      ["oauth:test-identity", "unscoped"],
      ["api-key:", "unscoped"],
      ["api-key:", "alpha"],
      ["api-key:", "beta"],
      ["oauth:test-subscription", "unscoped"],
    ]);
  });

  it("registers the configured Ollama transport and keeps the original api", () => {
    const secret = TEST_SECRET;
    const sentinel = TEST_SECRET_SENTINEL;
    const model = makeModel<"ollama">({
      id: "llama3",
      api: "ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      headers: { Authorization: `Bearer ${sentinel}` },
    });
    const cfg = {
      models: { providers: { ollama: { baseUrl: "http://remote-ollama:11434", models: [] } } },
    };

    const result = prepare({ model, cfg });

    expect(resolveStream).toHaveBeenCalledTimes(1);
    expect(resolveStream.mock.calls[0]?.[0].config).toBe(cfg);
    expect(resolveStream).toHaveBeenCalledWith({
      provider: "ollama",
      config: cfg,
      context: {
        config: cfg,
        provider: "ollama",
        modelId: "llama3",
        model: { ...model, headers: { Authorization: `Bearer ${secret}` } },
      },
    });
    expect(registerApi).toHaveBeenCalledWith(apiRegistry, "ollama", expect.any(Function));
    const registeredStream = registerApi.mock.calls[0]?.[2] as StreamFn;
    void registeredStream(
      { ...model, headers: { Authorization: `Bearer ${sentinel}` } } as never,
      {} as never,
      { apiKey: sentinel, headers: { "X-Managed": `Bearer ${sentinel}` } } as never,
    );
    expect(pluginStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { Authorization: `Bearer ${secret}` } }),
      {},
      { apiKey: secret, headers: { "X-Managed": `Bearer ${secret}` } },
    );
    expect(result).toBe(model);
  });

  it("aliases a provider-owned stream while preserving its null auth-header marker", async () => {
    const builtInStream = vi.fn(() => createAssistantMessageEventStream());
    apiRegistry.registerApiProvider(
      { api: "openai-completions", stream: builtInStream, streamSimple: builtInStream },
      "test:simple-completion-transport",
    );
    const model = makeModel<"openai-completions">({
      id: "qwen3-0.6b",
      api: "openai-completions",
      provider: "llama-cpp",
      baseUrl: "local://llama-cpp",
      headers: { Authorization: null },
    });

    const result = prepare({ model });

    const expectedApi =
      "openclaw-provider-stream:llama-cpp:qwen3-0.6b:openai-completions:local%3A%2F%2Fllama-cpp";
    expect(resolveStream).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "llama-cpp",
        context: expect.objectContaining({ model }),
      }),
    );
    expect(registerApi).toHaveBeenCalledWith(apiRegistry, expectedApi, expect.any(Function));
    expect(result).toEqual({ ...model, api: expectedApi });
    apiRegistry.getApiProvider("openai-completions")?.stream(model, { messages: [] });
    expect(builtInStream).toHaveBeenCalledOnce();
    expect(pluginStreamFn).not.toHaveBeenCalled();

    const registeredStream = registerApi.mock.calls.at(-1)?.[2] as StreamFn;
    await registeredStream(result, { messages: [] }, {});
    expect(pluginStreamFn).toHaveBeenCalledExactlyOnceWith(model, { messages: [] }, {});
  });

  it.each(["vertex", "transport"] as const)("registers the %s simple-completion alias", (kind) => {
    const vertex = kind === "vertex";
    const model = makeModel(
      vertex
        ? {
            api: "anthropic-messages",
            provider: "anthropic-vertex",
            baseUrl: "https://us-central1-aiplatform.googleapis.com",
          }
        : {
            api: "openai-responses",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
          },
    );
    const api = vertex
      ? "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com"
      : "openclaw-openai-responses-transport";
    resolveStream.mockReturnValueOnce(undefined);
    if (!vertex) {
      buildStream.mockReturnValueOnce("transport-stream");
      prepareTransportModel.mockReturnValueOnce({ ...model, api });
    }
    const result = prepare({ model });
    expect(registerApi).toHaveBeenCalledWith(
      apiRegistry,
      api,
      vertex ? "vertex-stream" : "transport-stream",
    );
    expect(result).toEqual({ ...model, api });
    if (vertex) {
      expect(vertexStream).toHaveBeenCalledWith(model);
      expect(inheritManagedTransport).toHaveBeenCalledWith(model, result);
    } else {
      expect(prepareTransportModel).toHaveBeenCalledWith(model, { cfg: undefined });
      expect(buildStream).toHaveBeenCalledWith(model, { cfg: undefined });
    }
  });

  it("normalizes Codex-response proxy URLs before transport dispatch", () => {
    const baseUrl = "https://proxy.example.test/openai/codex/responses";
    const expectedBaseUrl = "https://proxy.example.test/openai/codex";
    const model = makeChatGPTModel(baseUrl);

    resolveStream.mockReturnValueOnce(undefined);
    createStream.mockReturnValueOnce("codex-transport-stream");
    resolveTransportApi.mockReturnValueOnce("openclaw-openai-chatgpt-responses-transport");

    const result = prepare({ model });

    expect(createStream).toHaveBeenCalledWith(
      { ...model, baseUrl: expectedBaseUrl },
      { cfg: undefined },
    );
    expect(registerApi).toHaveBeenCalledWith(
      apiRegistry,
      "openclaw-openai-chatgpt-responses-transport",
      "codex-transport-stream",
    );
    expect(result).toEqual({
      ...model,
      baseUrl: expectedBaseUrl,
      api: "openclaw-openai-chatgpt-responses-transport",
    });
    expect(prepareTransportModel).not.toHaveBeenCalled();
  });

  it("rejects Codex proxy base URLs with fragments", () => {
    const model = makeChatGPTModel("https://proxy.example.test/openai#route");
    resolveStream.mockReturnValueOnce(undefined);

    expect(() => prepare({ model })).toThrow(
      "OpenAI Codex Responses baseUrl must not include query parameters or fragments",
    );
  });
});
