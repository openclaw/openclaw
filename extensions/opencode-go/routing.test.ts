import {
  createAiTransportHost,
  createApiRegistry,
  createNodeLlmRuntime,
  runWithAiTransportHost,
} from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { createBoundaryAwareStreamFnForModel } from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  resolveOpencodeGoModel,
} from "./provider-catalog.js";

const root = "https://opencode.ai/inference/go";
const families = [
  {
    id: "opaque-chat",
    api: "openai-completions",
    npm: "@ai-sdk/openai-compatible",
    baseUrl: root + "/openai/v1",
    suffix: "/chat/completions",
  },
  {
    id: "opaque-responses",
    api: "openai-responses",
    npm: "@ai-sdk/openai",
    baseUrl: root + "/openai/v1",
    suffix: "/responses",
  },
  {
    id: "opaque-anthropic",
    api: "anthropic-messages",
    npm: "@ai-sdk/anthropic",
    baseUrl: root + "/anthropic",
    suffix: "/v1/messages",
  },
  {
    id: "opaque-google",
    api: "google-generative-ai",
    npm: "@ai-sdk/google",
    baseUrl: root + "/google/v1beta",
    suffix: "/models/opaque-google:streamGenerateContent?alt=sse",
  },
] as const;
type Protocol = (typeof families)[number]["api"];

function wireResponse(api: Protocol, id: string): Response {
  let events: unknown[];
  switch (api) {
    case "openai-completions":
      events = [
        {
          id: "chat-fixture",
          choices: [
            { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
        },
      ];
      break;
    case "openai-responses":
      events = [
        {
          type: "response.completed",
          response: {
            id: "resp-fixture",
            object: "response",
            status: "completed",
            model: id,
            output: [
              {
                id: "msg-fixture",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      break;
    case "anthropic-messages":
      events = [
        {
          type: "message_start",
          message: {
            id: "msg-fixture",
            type: "message",
            role: "assistant",
            model: id,
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      break;
    case "google-generative-ai":
      events = [
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        },
      ];
      break;
    default:
      throw new Error("Missing wire response fixture");
  }
  return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => clearLiveCatalogCacheForTests());
afterEach(() => vi.unstubAllGlobals());

it.each(families)(
  "routes discovered and saved $api models to the correct family endpoint",
  async (family) => {
    const acquisitionUrls: string[] = [];
    const catalog = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "synthetic-key",
      fetchGuard: async ({ url }) => {
        acquisitionUrls.push(url);
        return {
          finalUrl: url,
          release: async () => {},
          response: Response.json(
            url === "https://models.opencode.ai/api.json"
              ? {
                  "opencode-go": {
                    id: "opencode-go",
                    api: root + "/openai/v1",
                    npm: "@ai-sdk/openai-compatible",
                    models: Object.fromEntries(
                      families.map((entry) => [
                        entry.id,
                        {
                          id: entry.id,
                          name: entry.id,
                          limit: { context: 128000, output: 8192 },
                          provider: {
                            npm: entry.npm,
                            api:
                              entry.api === "anthropic-messages"
                                ? entry.baseUrl + "/v1"
                                : entry.baseUrl,
                          },
                        },
                      ]),
                    ),
                  },
                }
              : { data: families.map(({ id }) => ({ id, object: "model" })) },
          ),
        };
      },
    });
    const row = catalog.models.find(({ id }) => id === family.id);
    expect(row).toMatchObject({ id: family.id, api: family.api, baseUrl: family.baseUrl });
    if (!row || !row.api || !row.contextWindow || !row.maxTokens) {
      throw new Error("Expected a complete discovered model");
    }
    const model: Model = {
      ...row,
      api: row.api,
      provider: "opencode-go",
      baseUrl: row.baseUrl ?? catalog.baseUrl,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      input: row.input.filter((kind) => kind === "text" || kind === "image"),
    };
    const provider = await registerSingleProviderPlugin(plugin);
    const requests: Request[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return wireResponse(family.api, family.id);
    };
    vi.stubGlobal("fetch", captureFetch);
    const host = createAiTransportHost({ buildModelFetch: () => captureFetch });
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    const runtime = createNodeLlmRuntime(registry, host);
    for (const baseUrl of [model.baseUrl, "https://opencode.ai/zen/go/v1"]) {
      const saved = { ...model, baseUrl };
      const resolved: Model = {
        ...saved,
        ...provider.normalizeResolvedModel?.({
          provider: "opencode-go",
          modelId: saved.id,
          model: saved,
        }),
      };
      expect(resolved).toMatchObject({ api: family.api, baseUrl: family.baseUrl });
      const result = await runWithAiTransportHost(host, async () => {
        if (family.api === "google-generative-ai") {
          return runtime.completeSimple(
            resolved,
            { messages: [{ role: "user", content: "Reply ok", timestamp: 1 }] },
            { apiKey: "synthetic-key", sessionId: "routing-fixture", cacheRetention: "none" },
          );
        }
        const stream = createBoundaryAwareStreamFnForModel(resolved);
        if (!stream) {
          throw new Error("Expected a native family transport");
        }
        return (
          await stream(
            resolved,
            { messages: [{ role: "user", content: "Reply ok", timestamp: 1 }] },
            { apiKey: "synthetic-key", sessionId: "routing-fixture", cacheRetention: "none" },
          )
        ).result();
      });
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
    }
    expect(requests.map(({ url }) => url)).toEqual([
      family.baseUrl + family.suffix,
      family.baseUrl + family.suffix,
    ]);
    expect(acquisitionUrls).toContain(root + "/v1/models");
    const proxy = { ...model, baseUrl: "https://proxy.example/v1" };
    expect(
      provider.normalizeResolvedModel?.({
        provider: "opencode-go",
        modelId: proxy.id,
        model: proxy,
      })?.baseUrl ?? proxy.baseUrl,
    ).toBe(proxy.baseUrl);
  },
);

it("keeps offline starter and dynamic fallback routes family-specific", () => {
  const catalog = buildStaticOpencodeGoProviderConfig();
  expect(catalog.baseUrl).toBe(root + "/openai/v1");
  expect(resolveOpencodeGoModel("gpt-5.6-luna")).toMatchObject({
    api: "openai-responses",
    baseUrl: root + "/openai/v1",
  });
  expect(resolveOpencodeGoModel("qwen3.8-max")).toMatchObject({
    api: "anthropic-messages",
    baseUrl: root + "/anthropic",
  });
});
