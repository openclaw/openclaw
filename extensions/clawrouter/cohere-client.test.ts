import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  buildClawRouterProviderConfig,
  normalizeClawRouterResolvedModel,
} from "./provider-catalog.js";

const MODEL = "cohere/command-a-plus-05-2026";
function catalog(eligible = true, format = "openai.chat_completions") {
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: "cohere",
        nativeBaseUrl: "/v1/native/cohere",
        allowed: true,
        executable: true,
        openaiCompatible: false,
        routes: [
          {
            endpoint: "compatibility_chat",
            path: "/compatibility/v1/chat/completions",
            requestFormat: format,
            responseFormat: format,
            methods: ["POST"],
          },
        ],
        models: [
          {
            id: MODEL,
            upstream: "command-a-plus-05-2026",
            capabilities: ["llm.chat"],
            supportedReasoningEfforts: ["none", "high"],
            input: ["text", "image"],
          },
        ],
        offers: [
          {
            endpoint: "compatibility_chat",
            modelId: MODEL,
            eligible,
            affordability: "request-dependent",
            transport: "http",
            routeKind: "native",
            route: "/v1/native/cohere/compatibility/v1/chat/completions",
          },
        ],
      },
    ],
  };
}

describe("ClawRouter Cohere compatibility client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearLiveCatalogCacheForTests();
  });
  const discover = async (payload = catalog()) => {
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
      response: Response.json(payload),
      finalUrl: "https://router.example/v1/catalog",
      release: async () => undefined,
    });
    return buildClawRouterProviderConfig({
      baseUrl: "https://router.example/v1",
      apiKey: "synthetic-router-key",
    });
  };

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "discovers and streams through %s",
    async (hook) => {
      const discovered = await discover();
      const row = discovered.models.find((model) => model.id === MODEL)!;
      const normalized = normalizeClawRouterResolvedModel({
        ...row,
        provider: "clawrouter",
      } as ProviderRuntimeModel)!;
      const model = {
        ...row,
        ...normalized,
        provider: "clawrouter",
      } as Model<"openai-completions">;
      expect(model).toMatchObject({
        api: "openai-completions",
        reasoning: true,
        baseUrl: "https://router.example/v1/native/cohere/compatibility/v1",
        compat: {
          supportsReasoningEffort: true,
        },
      });
      let wire: Record<string, unknown> | undefined;
      let destination: string | undefined;
      let authorization: string | null = null;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        destination = request.url;
        authorization = request.headers.get("Authorization");
        wire = (await request.json()) as Record<string, unknown>;
        const chunks = [
          {
            id: "fixture",
            object: "chat.completion.chunk",
            model: "command-a-plus-05-2026",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Synthetic Cohere result" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "fixture",
            object: "chat.completion.chunk",
            model: "command-a-plus-05-2026",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          },
        ];
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      });
      const provider = await registerSingleProviderPlugin(plugin);
      const wrapped = provider[hook]?.({
        provider: "clawrouter",
        modelId: MODEL,
        model,
        streamFn: streamSimple,
      });
      expect(wrapped).toBeDefined();
      const context = {
        systemPrompt: "Synthetic instructions",
        messages: [{ role: "user", content: "Look up a fixture", timestamp: 1 }],
        tools: [
          {
            name: "lookup",
            description: "Synthetic lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as Context;
      const stream = await wrapped!(model, context, {
        apiKey: "synthetic-router-key",
        maxTokens: 128,
      });
      const result = await stream.result();
      expect(destination).toBe(
        "https://router.example/v1/native/cohere/compatibility/v1/chat/completions",
      );
      expect(authorization).toBe("Bearer synthetic-router-key");
      expect(wire).toMatchObject({
        model: "command-a-plus-05-2026",
        max_tokens: 128,
        messages: expect.arrayContaining([
          { role: "developer", content: "Synthetic instructions" },
        ]),
      });
      for (const field of ["tool_choice", "store", "stream_options", "max_completion_tokens"]) {
        expect(wire).not.toHaveProperty(field);
      }
      expect(result.content).toContainEqual({ type: "text", text: "Synthetic Cohere result" });
      expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
      expect(result.stopReason).toBe("stop");
    },
  );

  it("does not advertise denied or native-v2-only offers", async () => {
    expect((await discover(catalog(false))).models).toEqual([]);
    clearLiveCatalogCacheForTests();
    expect((await discover(catalog(true, "cohere.chat"))).models).toEqual([]);
  });
});
