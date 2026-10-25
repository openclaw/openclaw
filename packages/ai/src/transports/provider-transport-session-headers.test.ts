import type {
  AssistantMessageEventStreamContract,
  AssistantMessageEventStreamLike,
  StreamFn,
} from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../../../../src/test-helpers/http.js";
import { createApiRegistry } from "../api-registry.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamSimpleGoogle } from "../providers/google.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { registerBuiltInApiProviders } from "../providers/register-builtins.js";
import type { Model } from "../types.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import { createBoundaryAwareStreamFnForModel } from "./provider-transport-stream.js";
import { prepareModelForSimpleCompletion } from "./simple-completion-transport.js";

const initialHost = getAiTransportHost();
function makeContext() {
  return { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
}

function captureRequests() {
  const requests: Request[] = [];
  const captureFetch: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return jsonResponse({ error: { message: "request captured" } }, 400);
  };
  return { requests, captureFetch };
}

function makeModel<T extends Model["api"]>(
  overrides: Pick<Model<T>, "api" | "provider" | "baseUrl"> & Partial<Model<T>>,
): Model<T> {
  return makeProviderModel(overrides.api, overrides.provider, "test-model", {
    name: "Test model",
    reasoning: false,
    maxTokens: 128,
    ...overrides,
  });
}

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

describe("managed Anthropic session affinity headers at fetch egress", () => {
  it("honors proxy opt-in", async () => {
    const { requests, captureFetch } = captureRequests();
    configureAiTransportHost({ ...initialHost, buildModelFetch: () => captureFetch });

    const stream = await createAnthropicMessagesTransportStreamFn()(
      makeModel({
        api: "anthropic-messages",
        provider: "anthropic-proxy",
        baseUrl: "https://messages-proxy.example.test",
        compat: { sendSessionAffinityHeaders: true },
      }),
      makeContext(),
      { apiKey: "test-key", sessionId: "conversation-a" },
    );
    await stream.result();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("x-session-affinity")).toBe("conversation-a");
  });
});

describe("managed OpenCode conversation headers at fetch egress", () => {
  it.each(["openai-completions", "anthropic-messages", "google-generative-ai"] as const)(
    "preserves conversation identity through %s",
    async (api) => {
      const { requests, captureFetch } = captureRequests();
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
      const baseModel = makeModel({
        api,
        provider: "opencode",
        baseUrl:
          api === "anthropic-messages" ? "https://opencode.ai/zen" : "https://opencode.ai/zen/v1",
      });

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
        const stream = await streamFn(model, makeContext(), {
          apiKey: "test-key",
          sessionId: "conversation-a",
          cacheRetention: testCase.cacheRetention,
          headers: "headers" in testCase ? testCase.headers : undefined,
        });
        await stream.result();
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers.get("x-opencode-session")).toBe(testCase.expected);
      }
    },
  );

  it.each([
    ["openai-completions", false],
    ["openai-responses", false],
    ["openai-completions", true],
    ["openai-responses", true],
  ] as const)(
    "applies sessionless %s turn fallback (simple completion: %s)",
    async (api, simple) => {
      const { requests, captureFetch } = captureRequests();
      configureAiTransportHost({
        ...initialHost,
        buildModelFetch: () => captureFetch,
        ...(simple ? { requiresManagedTransport: () => false } : {}),
        plugin: {
          ...initialHost.plugin,
          ...(simple ? { resolveProviderStream: () => undefined } : {}),
          resolveTransportTurnState: ({ context }) => ({
            headers: { "x-opencode-session": context.turnId, "x-provider-route": "route-a" },
          }),
        },
      });
      const apiRegistry = createApiRegistry();
      if (simple) {
        registerBuiltInApiProviders(apiRegistry);
      }
      const baseModel = makeModel({
        api,
        provider: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
      });
      for (const testCase of [
        { expected: "generated" },
        { modelHeaders: { "X-OpenCode-Session": "model-session" }, expected: "model-session" },
        { headers: { "x-opencode-session": "stream-session" }, expected: "stream-session" },
      ] as const) {
        const sourceModel = {
          ...baseModel,
          headers: "modelHeaders" in testCase ? testCase.modelHeaders : undefined,
        };
        const model = simple
          ? prepareModelForSimpleCompletion({ apiRegistry, model: sourceModel })
          : sourceModel;
        if (simple) {
          expect(model.api).toBe(api);
        }
        const streamFn = simple
          ? apiRegistry.getApiProvider(model.api)?.streamSimple
          : createBoundaryAwareStreamFnForModel(model);
        if (!streamFn) {
          throw new Error("No transport for " + api);
        }
        requests.length = 0;
        const stream = await streamFn(model, makeContext(), {
          apiKey: "test-key",
          headers: "headers" in testCase ? testCase.headers : undefined,
        });
        await stream.result();
        expect(requests).toHaveLength(1);
        const sessionHeader = requests[0]?.headers.get("x-opencode-session");
        if (testCase.expected === "generated") {
          expect(sessionHeader).toBeTruthy();
        } else {
          expect(sessionHeader).toBe(testCase.expected);
        }
        expect(requests[0]?.headers.get("x-provider-route")).toBe("route-a");
      }
    },
  );
});

describe("managed OpenAI Responses session headers at fetch egress", () => {
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
      name: "Azure proxy opt-in",
      api: "azure-openai-responses",
      managed: true,
      expectedApi: "azure-openai-responses",
      baseUrl: "https://responses-proxy.example.test/v1",
      sendSessionIdHeader: true,
      expected: "conversation-a",
    },
  ] as const)("preserves $name through prepared simple-completion dispatch", async (testCase) => {
    const { requests, captureFetch } = captureRequests();
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
    const sourceModel = makeModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: testCase.api,
      provider: "openai",
      baseUrl: testCase.baseUrl,
      reasoning: true,
      compat: { sendSessionIdHeader: testCase.sendSessionIdHeader },
    });
    const model = prepareModelForSimpleCompletion({ apiRegistry, model: sourceModel });
    expect(model.api).toBe(testCase.expectedApi);
    const provider = apiRegistry.getApiProvider(model.api);
    if (!provider) {
      throw new Error(`No provider registered for ${model.api}`);
    }

    const stream = provider.streamSimple(model, makeContext(), {
      apiKey: "test-key",
      sessionId: "conversation-a",
      cacheRetention: "short",
    });
    await stream.result();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("session_id")).toBe(testCase.expected);
  });
});
