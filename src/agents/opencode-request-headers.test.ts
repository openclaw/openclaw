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
import {
  completedResponse,
  wireMessage,
} from "../../packages/ai/src/transports/openai-stream-cases.test-support.js";
import type { Context, SimpleStreamOptions } from "../llm/types.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

type Protocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";
type Route = {
  api: Protocol;
  provider: string;
  baseUrl: string;
  native: boolean;
  suffix?: string;
};

// Independent wire fixtures exercise real adapters and SDK decoding, not policy mocks.
// No upstream account, inference, DNS, or socket is involved in this proof.
function sse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function responseFor(api: Protocol): Response {
  switch (api) {
    case "openai-completions":
      return sse([
        {
          id: "chatcmpl_fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        },
        {
          id: "chatcmpl_fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
      ]);
    case "openai-responses":
      return sse([
        completedResponse("resp_fixture", [wireMessage("msg_fixture", "ok")], {
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        }),
      ]);
    case "anthropic-messages":
      return createAnthropicResponse([
        {
          type: "message_start",
          message: {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: "fixture-model",
            content: [],
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    case "google-generative-ai":
      return sse([
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        },
      ]);
    default:
      throw new Error("Missing wire response fixture");
  }
}

const protocolPaths = [
  ["openai-completions", "openai/v1"],
  ["openai-responses", "openai/v1"],
  ["anthropic-messages", "anthropic/v1"],
  ["google-generative-ai", "google/v1beta"],
] as const;

// Both native manifest owners must recognize the new paths. Each proxy sibling
// protects a different adapter's header merge; old Zen routes cover its two URL shapes.
const routes: Route[] = [
  ...protocolPaths.flatMap(([api, path]) => [
    {
      api,
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/inference/go/" + path,
      native: true,
    },
    { api, provider: "opencode", baseUrl: "https://opencode.ai/inference/" + path, native: true },
    { api, provider: "opencode-go", baseUrl: "https://proxy.example/" + path, native: false },
  ]),
  ...(["opencode-go", "opencode"] as const).flatMap((provider) => {
    const baseUrl =
      provider === "opencode-go" ? "https://opencode.ai/zen/go" : "https://opencode.ai/zen";
    return [
      { api: "openai-completions" as const, provider, baseUrl: baseUrl + "/v1", native: true },
      {
        api: "anthropic-messages" as const,
        provider,
        baseUrl,
        native: true,
        suffix: "/v1/messages",
      },
    ];
  }),
];

const requestSuffix: Record<Protocol, string> = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
  "google-generative-ai": "/models/fixture-model:streamGenerateContent?alt=sse",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(routes)(
  "completes $api via $provider at $baseUrl with native=$native",
  async ({ api, provider, baseUrl, native, suffix }) => {
    const requests: Request[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return responseFor(api);
    };
    // Cover SDKs using global fetch as well as managed transports; neither can
    // escape to the network if request construction changes.
    vi.stubGlobal("fetch", captureFetch);
    const host = createAiTransportHost({
      buildModelFetch: () => captureFetch,
      resolveProviderRequestCapabilities,
      resolveProviderRequestHeaders: (
        input: Parameters<typeof resolveProviderRequestPolicyConfig>[0],
      ) => resolveProviderRequestPolicyConfig(input).headers,
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
          // A real caller header must replace the model header case-insensitively.
          ...(callerSession ? { "x-opencode-session": "model-session" } : {}),
        },
      });
      const context: Context = {
        messages: [{ role: "user", content: "Reply ok", timestamp: 1 }],
      };
      const options: SimpleStreamOptions = {
        apiKey: "synthetic-key",
        sessionId: "conversation-123",
        cacheRetention: "none",
        headers: {
          "X-Custom": "keep-caller",
          // Native attribution must not accept another coding agent's identity.
          "uSeR-aGeNt": "fixture-caller/1",
          ...(callerSession ? { "X-OpenCode-Session": "caller-session" } : {}),
        },
      };

      for (let turn = 0; turn < 2; turn++) {
        // The runner selects these boundary-aware transports for OpenAI and
        // Anthropic. Gemini uses the registered lazy adapter and real Google SDK.
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
      expect(request.method).toBe("POST");
      expect(request.url).toBe(baseUrl + (suffix ?? requestSuffix[api]));
      expect(request.headers.get("x-model")).toBe("keep-model");
      expect(request.headers.get("x-custom")).toBe("keep-caller");
      if (native) {
        expect(request.headers.get("user-agent")).toMatch(/^openclaw\/[^\s,]+$/);
      } else {
        expect(request.headers.get("user-agent")).not.toMatch(/(?:^|[ ,])openclaw\//);
        expect(request.headers.get("user-agent")).toContain("fixture-caller/1");
      }
      expect(request.headers.get("x-opencode-session")).toBe(
        index >= 2 ? "caller-session" : native ? "conversation-123" : null,
      );
      const payload: unknown = await request.json();
      expect(payload).not.toHaveProperty("prompt_cache_key");
      expect(payload).not.toHaveProperty("cachedContent");
      expect(JSON.stringify(payload)).not.toContain('"cache_control"');
      if (api === "google-generative-ai") {
        expect(request.headers.get("x-goog-api-key")).toBe("synthetic-key");
        expect(payload).toMatchObject({ contents: expect.any(Array) });
      } else {
        expect(payload).toMatchObject({ model: "fixture-model", stream: true });
        expect(
          request.headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization"),
        ).toBe(api === "anthropic-messages" ? "synthetic-key" : "Bearer synthetic-key");
      }
    }
  },
);
