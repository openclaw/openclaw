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
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  resolveOpencodeGoModel,
} from "./provider-catalog.js";

const root = "https://opencode.ai/inference/go";
const families = (
  [
    ["openai-completions", "openai-compatible", "/openai/v1", "/chat/completions"],
    ["openai-responses", "openai", "/openai/v1", "/responses"],
    ["anthropic-messages", "anthropic", "/anthropic", "/v1/messages"],
    ["google-generative-ai", "google", "/google/v1beta", ":streamGenerateContent?alt=sse"],
  ] as const
).map(([api, sdk, path, suffix]) => ({
  id: "opaque-" + sdk,
  api,
  npm: "@ai-sdk/" + sdk,
  baseUrl: root + path,
  suffix: sdk === "google" ? "/models/opaque-google" + suffix : suffix,
}));
type Protocol = (typeof families)[number]["api"];

function wireResponse(api: Protocol, id: string): Response {
  const events: Record<Protocol, string[]> = {
    "openai-completions": [
      '{"id":"chat-fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}',
    ],
    "openai-responses": [
      `{"type":"response.completed","response":{"id":"resp-fixture","object":"response","status":"completed","model":${JSON.stringify(id)},"output":[{"id":"msg-fixture","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`,
    ],
    "anthropic-messages": [
      `{"type":"message_start","message":{"id":"msg-fixture","type":"message","role":"assistant","model":${JSON.stringify(id)},"content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
      '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '{"type":"message_stop"}',
    ],
    "google-generative-ai": [
      '{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}',
    ],
  };
  return new Response(events[api].map((event) => "data: " + event + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => clearLiveCatalogCacheForTests());
afterEach(() => vi.unstubAllGlobals());

it.each(families)("routes discovered and saved $api models", async (family) => {
  const { id, api, npm, baseUrl, suffix } = family;
  const metadata = {
    "opencode-go": {
      id: "opencode-go",
      api: root + "/openai/v1",
      models: {
        [id]: {
          id,
          limit: { context: 128000, output: 8192 },
          provider: { npm, api: api === "anthropic-messages" ? baseUrl + "/v1" : baseUrl },
        },
      },
    },
  };
  const discoveryUrls: string[] = [];
  const catalog = await buildOpencodeGoLiveProviderConfig({
    discoveryApiKey: "synthetic-key",
    fetchGuard: async ({ url }) => {
      discoveryUrls.push(url);
      assert(
        url === "https://models.opencode.ai/api.json" || url === root + "/v1/models",
        `Unexpected discovery URL: ${url}`,
      );
      return {
        finalUrl: url,
        release: async () => {},
        response: Response.json(
          url === "https://models.opencode.ai/api.json"
            ? metadata
            : { data: [{ id, object: "model" }] },
        ),
      };
    },
  });
  expect(discoveryUrls).toContain(root + "/v1/models");
  const row = catalog.models.find((model) => model.id === id);
  expect(row).toMatchObject({ id, api, baseUrl });
  assert(row && row.api && row.contextWindow && row.maxTokens, "Incomplete model");
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
  const normalize = (next: Model) =>
    provider.normalizeResolvedModel?.({ provider: next.provider, modelId: next.id, model: next });
  const requests: Request[] = [];
  const captureFetch: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return wireResponse(api, id);
  };
  vi.stubGlobal("fetch", captureFetch);
  const host = createAiTransportHost({ buildModelFetch: () => captureFetch });
  const registry = createApiRegistry();
  registerBuiltInApiProviders(registry);
  const runtime = createNodeLlmRuntime(registry, host);
  const context = { messages: [{ role: "user" as const, content: "Reply ok", timestamp: 1 }] };
  const options = {
    apiKey: "synthetic-key",
    sessionId: "routing-fixture",
    cacheRetention: "none" as const,
  };
  for (const savedBaseUrl of [model.baseUrl, "https://opencode.ai/zen/go/v1"]) {
    const saved = { ...model, baseUrl: savedBaseUrl };
    const resolved: Model = { ...saved, ...normalize(saved) };
    expect(resolved).toMatchObject({ api, baseUrl });
    const result = await runWithAiTransportHost(host, async () => {
      if (api === "google-generative-ai") {
        return runtime.completeSimple(resolved, context, options);
      }
      const stream = createBoundaryAwareStreamFnForModel(resolved);
      assert(stream, "Expected a native family transport");
      return (await stream(resolved, context, options)).result();
    });
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
  }
  expect(requests.map(({ url }) => url)).toEqual([baseUrl + suffix, baseUrl + suffix]);
  const proxy = { ...model, baseUrl: "https://proxy.example/v1" };
  expect(normalize(proxy)?.baseUrl ?? proxy.baseUrl).toBe(proxy.baseUrl);
});

it("keeps offline starter and dynamic fallback routes family-specific", () => {
  expect(buildStaticOpencodeGoProviderConfig().baseUrl).toBe(root + "/openai/v1");
  expect(resolveOpencodeGoModel("gpt-5.6-luna")).toMatchObject({
    api: "openai-responses",
    baseUrl: root + "/openai/v1",
  });
  expect(resolveOpencodeGoModel("qwen3.8-max")).toMatchObject({
    api: "anthropic-messages",
    baseUrl: root + "/anthropic",
  });
});
