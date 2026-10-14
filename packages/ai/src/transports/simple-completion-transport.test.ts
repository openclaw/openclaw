import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import type { Api, AssistantMessageEventStreamContract, Model, StreamFn } from "@openclaw/llm-core";
// Simple completion transport tests cover provider-specific stream alias
// selection before the generic completion helper invokes the LLM layer.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRegistry, type ApiRegistry } from "../api-registry.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";

const createAnthropicVertexStreamFnForModel = vi.fn();
const ensureCustomApiRegistered = vi.fn();
const resolveProviderStreamFn = vi.fn();
const wrapProviderSimpleCompletionStreamFn = vi.fn();
const buildTransportAwareSimpleStreamFn = vi.fn();
const createOpenClawTransportStreamFnForModel = vi.fn();
const createTransportAwareStreamFnForModel = vi.fn();
const prepareTransportAwareSimpleModel = vi.fn();
const resolveTransportAwareSimpleApi = vi.fn();
const inheritManagedTransport = vi.fn((_source: Model, target: Model) => target);
const pluginStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
const TEST_SECRET = "ollama-provider-secret";
const TEST_SECRET_SENTINEL = "test-secret-sentinel";
const initialHost = getAiTransportHost();

vi.mock("./provider-transport-stream.js", () => ({
  buildTransportAwareSimpleStreamFn,
  createOpenClawTransportStreamFnForModel,
  createTransportAwareStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
}));

let prepareModelForSimpleCompletionImpl: typeof import("./simple-completion-transport.js").prepareModelForSimpleCompletion;
let apiRegistry: ApiRegistry;
const SIMPLE_COMPLETION_SOURCE_ID = "test:simple-completion-transport";

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

function prepareModelForSimpleCompletion(
  params: Omit<
    Parameters<
      typeof import("./simple-completion-transport.js").prepareModelForSimpleCompletion
    >[0],
    "apiRegistry"
  >,
) {
  return prepareModelForSimpleCompletionImpl({ ...params, apiRegistry });
}

describe("prepareModelForSimpleCompletion", () => {
  beforeAll(async () => {
    // Dynamic import lets the mocked transport/provider modules settle before
    // the unit under test captures custom stream registration helpers.
    ({ prepareModelForSimpleCompletion: prepareModelForSimpleCompletionImpl } =
      await import("./simple-completion-transport.js"));
  });

  beforeEach(() => {
    apiRegistry = createApiRegistry();
    createAnthropicVertexStreamFnForModel.mockReset();
    ensureCustomApiRegistered.mockReset();
    ensureCustomApiRegistered.mockImplementation(
      (registry: ApiRegistry, api: Api, _streamFn: StreamFn) => {
        if (registry.getApiProvider(api)) {
          return false;
        }
        const stream = () => createAssistantMessageEventStream();
        registry.registerApiProvider({ api, stream, streamSimple: stream });
        return true;
      },
    );
    resolveProviderStreamFn.mockReset();
    pluginStreamFn.mockClear();
    wrapProviderSimpleCompletionStreamFn.mockReset();
    buildTransportAwareSimpleStreamFn.mockReset();
    createOpenClawTransportStreamFnForModel.mockReset();
    createTransportAwareStreamFnForModel.mockReset();
    prepareTransportAwareSimpleModel.mockReset();
    resolveTransportAwareSimpleApi.mockReset();
    inheritManagedTransport.mockClear();
    createAnthropicVertexStreamFnForModel.mockReturnValue("vertex-stream");
    resolveProviderStreamFn.mockReturnValue(pluginStreamFn);
    wrapProviderSimpleCompletionStreamFn.mockReturnValue(undefined);
    buildTransportAwareSimpleStreamFn.mockReturnValue(undefined);
    createOpenClawTransportStreamFnForModel.mockReturnValue(undefined);
    createTransportAwareStreamFnForModel.mockReturnValue(undefined);
    prepareTransportAwareSimpleModel.mockImplementation((model) => model);
    resolveTransportAwareSimpleApi.mockReturnValue(undefined);
    configureAiTransportHost({
      plugin: {
        resolveProviderStream: resolveProviderStreamFn,
        resolveTransportTurnState: () => undefined,
        wrapSimpleCompletionStream: wrapProviderSimpleCompletionStreamFn,
        createAnthropicVertexStream: createAnthropicVertexStreamFnForModel,
      },
      registerCustomApi: ensureCustomApiRegistered,
      inheritManagedTransport,
      resolveSecretSentinel: (value) => value.replaceAll(TEST_SECRET_SENTINEL, TEST_SECRET),
    });
  });

  afterAll(() => {
    configureAiTransportHost(initialHost);
  });

  it("keeps each selected auth and agent policy when completions share a model registry", () => {
    ensureCustomApiRegistered.mockImplementation(
      (registry: ApiRegistry, api: Api, streamFn: StreamFn) => {
        if (registry.getApiProvider(api)) {
          return false;
        }
        const stream = (...args: Parameters<StreamFn>) =>
          requireSynchronousStream(streamFn(...args));
        registry.registerApiProvider({ api, stream, streamSimple: stream });
        return true;
      },
    );
    wrapProviderSimpleCompletionStreamFn.mockImplementation(
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
    const model: Model = {
      id: "test-model",
      name: "Test Model",
      api: "test-auth-policy",
      provider: "test-provider",
      baseUrl: "https://example.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
    };
    const prepared = [
      { auth: { mode: "oauth", authFlow: "test-subscription" } },
      { auth: { mode: "oauth", authFlow: "test-identity" } },
      { auth: { mode: "api-key" } },
      { auth: { mode: "api-key" }, agentId: "alpha" },
      { auth: { mode: "api-key" }, agentId: "beta" },
    ].map((selection) => prepareModelForSimpleCompletion({ model, ...selection }));

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
    const model: Model<"ollama"> = {
      id: "llama3",
      name: "Llama 3",
      api: "ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
      headers: { Authorization: `Bearer ${sentinel}` },
    };
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://remote-ollama:11434",
            models: [],
          },
        },
      },
    };

    const result = prepareModelForSimpleCompletion({
      model,
      cfg,
    });

    expect(resolveProviderStreamFn).toHaveBeenCalledTimes(1);
    const [request] = resolveProviderStreamFn.mock.calls.at(0) as [
      {
        provider?: unknown;
        config?: unknown;
        context?: { provider?: unknown; modelId?: unknown; model?: unknown };
      },
    ];
    expect(request.provider).toBe("ollama");
    expect(request.config).toBe(cfg);
    expect(request.context?.provider).toBe("ollama");
    expect(request.context?.modelId).toBe("llama3");
    expect(request.context?.model).toEqual({
      ...model,
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      apiRegistry,
      "ollama",
      expect.any(Function),
    );
    const registeredStream = ensureCustomApiRegistered.mock.calls[0]?.[2] as StreamFn;
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
      {
        api: "openai-completions",
        stream: builtInStream,
        streamSimple: builtInStream,
      },
      SIMPLE_COMPLETION_SOURCE_ID,
    );
    const model: Model<"openai-completions"> = {
      id: "qwen3-0.6b",
      name: "Qwen3 0.6B",
      api: "openai-completions",
      provider: "llama-cpp",
      baseUrl: "local://llama-cpp",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 2048,
      headers: { Authorization: null } as never,
    };

    const result = prepareModelForSimpleCompletion({ model });

    const expectedApi =
      "openclaw-provider-stream:llama-cpp:qwen3-0.6b:openai-completions:local%3A%2F%2Fllama-cpp";
    expect(resolveProviderStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "llama-cpp",
        context: expect.objectContaining({ model }),
      }),
    );
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      apiRegistry,
      expectedApi,
      expect.any(Function),
    );
    expect(result).toEqual({ ...model, api: expectedApi });
    apiRegistry.getApiProvider("openai-completions")?.stream(model, { messages: [] });
    expect(builtInStream).toHaveBeenCalledOnce();
    expect(pluginStreamFn).not.toHaveBeenCalled();

    const registeredStream = ensureCustomApiRegistered.mock.calls.at(-1)?.[2] as StreamFn;
    await registeredStream(result, { messages: [] }, {});
    expect(pluginStreamFn).toHaveBeenCalledExactlyOnceWith(model, { messages: [] }, {});
  });

  it("uses a custom api alias for Anthropic Vertex simple completions", () => {
    const model: Model<"anthropic-messages"> = {
      id: "claude-sonnet",
      name: "Claude Sonnet",
      api: "anthropic-messages",
      provider: "anthropic-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };

    resolveProviderStreamFn.mockReturnValueOnce(undefined);

    const result = prepareModelForSimpleCompletion({ model });

    expect(createAnthropicVertexStreamFnForModel).toHaveBeenCalledWith(model);
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      apiRegistry,
      "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com",
      "vertex-stream",
    );
    expect(result).toEqual({
      ...model,
      api: "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com",
    });
    expect(inheritManagedTransport).toHaveBeenCalledWith(model, result);
  });

  it("uses a transport-aware custom api alias when llm request transport overrides are present", () => {
    const model: Model<"openai-responses"> = {
      id: "gpt-5",
      name: "GPT-5",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };

    resolveProviderStreamFn.mockReturnValueOnce(undefined);
    buildTransportAwareSimpleStreamFn.mockReturnValueOnce("transport-stream");
    prepareTransportAwareSimpleModel.mockReturnValueOnce({
      ...model,
      api: "openclaw-openai-responses-transport",
    });

    const result = prepareModelForSimpleCompletion({ model });

    expect(prepareTransportAwareSimpleModel).toHaveBeenCalledWith(model, { cfg: undefined });
    expect(buildTransportAwareSimpleStreamFn).toHaveBeenCalledWith(model, { cfg: undefined });
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      apiRegistry,
      "openclaw-openai-responses-transport",
      "transport-stream",
    );
    expect(result).toEqual({
      ...model,
      api: "openclaw-openai-responses-transport",
    });
  });

  it.each([
    [
      "https://proxy.example.test/openai/codex/responses",
      "https://proxy.example.test/openai/codex",
    ],
  ])(
    "uses OpenClaw transport for OpenAI Codex-response simple completions with baseUrl %s",
    (baseUrl, expectedBaseUrl) => {
      const model: Model<"openai-chatgpt-responses"> = {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        provider: "openai",
        baseUrl,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      };

      resolveProviderStreamFn.mockReturnValueOnce(undefined);
      createOpenClawTransportStreamFnForModel.mockReturnValueOnce("codex-transport-stream");
      resolveTransportAwareSimpleApi.mockReturnValueOnce(
        "openclaw-openai-chatgpt-responses-transport",
      );

      const result = prepareModelForSimpleCompletion({ model });

      // ChatGPT/Codex response endpoints share the transport stream, but the
      // simple-completion API must normalize caller-supplied base URLs first.
      expect(createOpenClawTransportStreamFnForModel).toHaveBeenCalledWith(
        {
          ...model,
          baseUrl: expectedBaseUrl,
        },
        { cfg: undefined },
      );
      expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
        apiRegistry,
        "openclaw-openai-chatgpt-responses-transport",
        "codex-transport-stream",
      );
      expect(result).toEqual({
        ...model,
        baseUrl: expectedBaseUrl,
        api: "openclaw-openai-chatgpt-responses-transport",
      });
      expect(prepareTransportAwareSimpleModel).not.toHaveBeenCalled();
    },
  );

  it.each(["https://proxy.example.test/openai#route"])(
    "rejects Codex proxy base URLs with query or fragment components: %s",
    (baseUrl) => {
      const model: Model<"openai-chatgpt-responses"> = {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        provider: "openai",
        baseUrl,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      };
      resolveProviderStreamFn.mockReturnValueOnce(undefined);

      expect(() => prepareModelForSimpleCompletion({ model })).toThrow(
        "OpenAI Codex Responses baseUrl must not include query parameters or fragments",
      );
    },
  );
});
