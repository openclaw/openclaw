import {
  createAiTransportHost,
  createApiRegistry,
  createNodeLlmRuntime,
  runWithAiTransportHost,
} from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { createBoundaryAwareStreamFnForModel } from "@openclaw/ai/transports";
import { afterEach, expect, it, vi } from "vitest";
import { createAnthropicResponse } from "../../packages/ai/src/provider-transport-parity.test-support.js";
import { createSseResponse } from "../../packages/ai/src/transports/anthropic-transport-stream.test-support.js";
import {
  completedResponse,
  wireMessage,
} from "../../packages/ai/src/transports/openai-stream-cases.test-support.js";
import type { Context, SimpleStreamOptions } from "../llm/types.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

type Protocol = (typeof protocolPaths)[number][0];
type Route = [api: Protocol, provider: string, baseUrl: string, native: boolean, suffix?: string];

// Usage accounting has dedicated provider tests; these fixtures prove request headers and replies.
const replies: Record<Protocol, Record<string, unknown>[]> = {
  "openai-completions": [
    {
      id: "chatcmpl_fixture",
      model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_fixture",
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ],
  "openai-responses": [completedResponse("resp", [wireMessage("msg", "ok")])],
  "anthropic-messages": [
    { type: "message_start", message: { id: "msg_fixture", model: "fixture-model" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ],
  "google-generative-ai": [
    {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    },
  ],
};
function responseFor(api: Protocol): Response {
  return api === "anthropic-messages"
    ? createAnthropicResponse(replies[api])
    : createSseResponse(replies[api]);
}

const protocolPaths = [
  ["openai-completions", "openai/v1"],
  ["openai-responses", "openai/v1"],
  ["anthropic-messages", "anthropic/v1"],
  ["google-generative-ai", "google/v1beta"],
] as const;

// Exercise both manifest owners, each proxy adapter, and both legacy Zen URL shapes.
const routes: Route[] = [
  ...protocolPaths.flatMap(([api, path]): Route[] => [
    [api, "opencode-go", "https://opencode.ai/inference/go/" + path, true],
    [api, "opencode", "https://opencode.ai/inference/" + path, true],
    [api, "opencode-go", "https://proxy.example/" + path, false],
  ]),
  ...(["opencode-go", "opencode"] as const).flatMap((provider): Route[] => {
    const baseUrl =
      provider === "opencode-go" ? "https://opencode.ai/zen/go" : "https://opencode.ai/zen";
    return [
      ["openai-completions", provider, baseUrl + "/v1", true],
      ["anthropic-messages", provider, baseUrl, true, "/v1/messages"],
    ];
  }),
];

const requestSuffix: Record<Protocol, string> = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
  "google-generative-ai": "/models/fixture-model:streamGenerateContent?alt=sse",
};

afterEach(() => vi.unstubAllGlobals());

it.each(routes)(
  "completes %s via %s at %s with native=%s",
  async (api, provider, baseUrl, native, suffix) => {
    const requests: Request[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return responseFor(api);
    };
    // Stub both SDK-global and managed fetches so neither can escape to the network.
    vi.stubGlobal("fetch", captureFetch);
    const host = createAiTransportHost({
      buildModelFetch: () => captureFetch,
      resolveProviderRequestCapabilities,
      resolveProviderRequestHeaders: (input) => resolveProviderRequestPolicyConfig(input).headers,
    });
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    const runtime = createNodeLlmRuntime(registry, host);

    for (const callerSession of [false, true]) {
      const model = makeProviderModelFixture<Protocol>({
        id: "fixture-model",
        api,
        provider,
        baseUrl,
        headers: {
          "X-Model": "keep-model",
          ...(callerSession ? { "x-opencode-session": "model-session" } : {}),
        },
      });
      const context: Context = { messages: [{ role: "user", content: "Reply ok", timestamp: 1 }] };
      const options: SimpleStreamOptions = {
        apiKey: "synthetic-key",
        sessionId: "conversation-123",
        cacheRetention: "none",
        headers: {
          "X-Custom": "keep-caller",
          "uSeR-aGeNt": "fixture-caller/1",
          ...(callerSession ? { "X-OpenCode-Session": "caller-session" } : {}),
        },
      };

      for (let turn = 0; turn < 2; turn++) {
        // Gemini uses its SDK; other APIs use the runner's boundary-aware transport.
        const result = await runWithAiTransportHost(host, async () => {
          if (api === "google-generative-ai") {
            return runtime.completeSimple(model, context, options);
          }
          const streamFn = createBoundaryAwareStreamFnForModel(model);
          if (!streamFn) {
            throw new Error("Expected a runner transport for " + api);
          }
          return (await streamFn(model, context, options)).result();
        });
        expect(result.stopReason, result.errorMessage).toBe("stop");
        expect(result.role).toBe("assistant");
        expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
        context.messages.push(result, { role: "user", content: "Again", timestamp: 2 });
      }
    }

    // One physical request per turn; no rejected response or retry is hidden.
    expect(requests).toHaveLength(4);
    for (const [index, request] of requests.entries()) {
      const header = (name: string) => request.headers.get(name);
      expect(request.method).toBe("POST");
      expect(request.url).toBe(baseUrl + (suffix ?? requestSuffix[api]));
      expect(header("x-model")).toBe("keep-model");
      expect(header("x-custom")).toBe("keep-caller");
      if (native) {
        expect(header("user-agent")).toMatch(/^openclaw\/[^\s,]+$/);
      } else {
        expect(header("user-agent")).not.toMatch(/(?:^|[ ,])openclaw\//);
        expect(header("user-agent")).toContain("fixture-caller/1");
      }
      expect(header("x-opencode-session")).toBe(
        index >= 2 ? "caller-session" : native ? "conversation-123" : null,
      );
      const payload: unknown = await request.json();
      expect(payload).not.toHaveProperty("prompt_cache_key");
      expect(payload).not.toHaveProperty("cachedContent");
      expect(JSON.stringify(payload)).not.toContain('"cache_control"');
      if (api === "google-generative-ai") {
        expect(header("x-goog-api-key")).toBe("synthetic-key");
        expect(payload).toMatchObject({ contents: expect.any(Array) });
      } else {
        expect(payload).toMatchObject({ model: "fixture-model", stream: true });
        expect(header(api === "anthropic-messages" ? "x-api-key" : "authorization")).toBe(
          api === "anthropic-messages" ? "synthetic-key" : "Bearer synthetic-key",
        );
      }
    }
  },
);
