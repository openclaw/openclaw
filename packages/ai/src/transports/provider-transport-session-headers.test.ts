import type {
  AssistantMessageEventStreamContract,
  AssistantMessageEventStreamLike,
  StreamFn,
} from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiRegistry } from "../api-registry.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamSimpleGoogle } from "../providers/google.js";
import type { Model } from "../types.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";
import { createBoundaryAwareStreamFnForModel } from "./provider-transport-stream.js";
import { prepareModelForSimpleCompletion } from "./simple-completion-transport.js";

const initialHost = getAiTransportHost();

function isSynchronousStream(
  stream: AssistantMessageEventStreamLike,
): stream is AssistantMessageEventStreamContract {
  return (
    "push" in stream &&
    typeof stream.push === "function" &&
    "end" in stream &&
    typeof stream.end === "function"
  );
}

function requireSynchronousStream(
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  if (stream instanceof Promise || !isSynchronousStream(stream)) {
    throw new Error("Expected synchronous assistant event stream");
  }
  return stream;
}

afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.unstubAllGlobals();
});

describe("managed OpenCode conversation headers at fetch egress", () => {
  it.each([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ] as const)("preserves conversation identity through %s", async (api) => {
    const requests: Request[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ error: { message: "request captured" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    vi.stubGlobal("fetch", captureFetch);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => captureFetch,
      plugin: {
        ...initialHost.plugin,
        resolveProviderStream: () => (model, context, options) => {
          // The plugin boundary must receive identity before any SDK adapter can add it.
          if (!model.headers?.["X-OpenCode-Session"]) {
            expect(options?.headers?.["x-opencode-session"]).toBe("conversation-a");
          }
          return streamSimpleGoogle(
            { ...model, api: "google-generative-ai", compat: undefined },
            context,
            options,
          );
        },
      },
    });
    const baseModel = {
      id: "test-model",
      name: "Test model",
      api,
      provider: "opencode",
      baseUrl:
        api === "anthropic-messages" ? "https://opencode.ai/zen" : "https://opencode.ai/zen/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 128,
    } satisfies Model;

    for (const testCase of [
      { cacheRetention: "none", expected: "conversation-a" },
      { cacheRetention: "short", expected: "conversation-a" },
      {
        cacheRetention: "none",
        modelHeaders: { "X-OpenCode-Session": "model-session" },
        expected: "model-session",
      },
      {
        cacheRetention: "none",
        modelHeaders: { "X-OpenCode-Session": "model-session" },
        headers: { "x-opencode-session": "stream-session" },
        expected: "stream-session",
      },
    ] as const) {
      const model = {
        ...baseModel,
        headers: "modelHeaders" in testCase ? testCase.modelHeaders : undefined,
      };
      const streamFn = createBoundaryAwareStreamFnForModel(model);
      if (!streamFn) {
        throw new Error(`No managed transport for ${api}`);
      }
      requests.length = 0;
      const stream = await streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        },
        {
          apiKey: "test-key",
          sessionId: "conversation-a",
          cacheRetention: testCase.cacheRetention,
          headers: "headers" in testCase ? testCase.headers : undefined,
        },
      );
      await stream.result();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("x-opencode-session")).toBe(testCase.expected);
    }
  });
});

describe("managed OpenAI Responses session headers at fetch egress", () => {
  it.each([
    { api: "openai-responses", cacheRetention: "short", expected: "conversation-a" },
    { api: "openai-responses", cacheRetention: "none", expected: null },
    { api: "azure-openai-responses", cacheRetention: "short", expected: "conversation-a" },
    { api: "azure-openai-responses", cacheRetention: "none", expected: null },
  ] as const)("honors $api proxy opt-in with cacheRetention=$cacheRetention", async (testCase) => {
    const requests: Request[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ error: { message: "request captured" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    configureAiTransportHost({ ...initialHost, buildModelFetch: () => captureFetch });

    const streamFn =
      testCase.api === "azure-openai-responses"
        ? createAzureOpenAIResponsesTransportStreamFn()
        : createOpenAIResponsesTransportStreamFn();
    const stream = await streamFn(
      {
        id: "test-model",
        name: "Test model",
        api: testCase.api,
        provider: "openai-proxy",
        baseUrl: "https://responses-proxy.example.test/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 128,
        compat: { sendSessionIdHeader: true },
      },
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      {
        apiKey: "test-key",
        sessionId: "conversation-a",
        cacheRetention: testCase.cacheRetention,
      },
    );
    await stream.result();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("session_id")).toBe(testCase.expected);
  });

  it.each([
    {
      name: "proxy opt-in",
      api: "openai-chatgpt-responses",
      managed: false,
      expectedApi: "openclaw-openai-chatgpt-responses-transport",
      baseUrl: "https://responses-proxy.example.test/openai",
      sendSessionIdHeader: true,
      expected: "conversation-a",
    },
    {
      name: "native opt-out",
      api: "openai-chatgpt-responses",
      managed: false,
      expectedApi: "openclaw-openai-chatgpt-responses-transport",
      baseUrl: "https://chatgpt.com/backend-api",
      sendSessionIdHeader: false,
      expected: null,
    },
    {
      name: "OpenAI proxy opt-in",
      api: "openai-responses",
      managed: true,
      expectedApi: "openai-responses",
      baseUrl: "https://responses-proxy.example.test/v1",
      sendSessionIdHeader: true,
      expected: "conversation-a",
    },
    {
      name: "Azure proxy opt-in",
      api: "azure-openai-responses",
      managed: true,
      expectedApi: "azure-openai-responses",
      baseUrl: "https://responses-proxy.example.test/v1",
      sendSessionIdHeader: true,
      expected: "conversation-a",
    },
  ] as const)("preserves $name through prepared simple-completion dispatch", async (testCase) => {
    const requests: Request[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ error: { message: "request captured" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => captureFetch,
      requiresManagedTransport: () => testCase.managed,
      plugin: { ...initialHost.plugin, resolveProviderStream: () => undefined },
      registerCustomApi: (registry, api, streamFn) => {
        if (registry.getApiProvider(api)) {
          return false;
        }
        const registeredStream = (
          model: Model,
          context: Parameters<StreamFn>[1],
          options?: Parameters<StreamFn>[2],
        ) => requireSynchronousStream(streamFn(model, context, options));
        registry.registerApiProvider({
          api,
          stream: registeredStream,
          streamSimple: registeredStream,
        });
        return true;
      },
    });

    const apiRegistry = createApiRegistry();
    const sourceModel = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: testCase.api,
      provider: "openai",
      baseUrl: testCase.baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 128,
      compat: { sendSessionIdHeader: testCase.sendSessionIdHeader },
    } as Model;
    const model = prepareModelForSimpleCompletion({
      apiRegistry,
      model: sourceModel,
    });
    expect(model.api).toBe(testCase.expectedApi);
    const provider = apiRegistry.getApiProvider(model.api);
    if (!provider) {
      throw new Error(`No provider registered for ${model.api}`);
    }

    const stream = provider.streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "test-key", sessionId: "conversation-a", cacheRetention: "short" },
    );
    await stream.result();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("session_id")).toBe(testCase.expected);
  });
});
