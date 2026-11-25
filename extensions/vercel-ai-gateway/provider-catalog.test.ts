import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchMock,
}));

import { discoverVercelAiGatewayModels, VERCEL_AI_GATEWAY_BASE_URL } from "./api.js";
import {
  buildStaticVercelAiGatewayProvider as staticProvider,
  buildVercelAiGatewayProvider as buildProvider,
  resolveVercelAiGatewayModel as resolveModel,
} from "./provider-catalog.js";

function mockResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchMock.mockResolvedValueOnce({ response, release, finalUrl: endpoint });
  return release;
}

const endpoint = `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`;
const mockCatalog = (data: unknown[], status = 200) => mockResponse(jsonResponse({ data }, status));
const pricedModel = (id: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  id,
  cost: { input, output, cacheRead, cacheWrite },
});

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchMock.mockReset();
});

it("falls back to the static provider on HTTP 503", async () => {
  const release = mockCatalog([], 503);
  await expect(buildProvider()).resolves.toEqual(staticProvider());
  expect(release).toHaveBeenCalledOnce();
});

it("preserves thinking and vision for live-only upstream models", () => {
  expect(resolveModel("openai/gpt-5.5")).toMatchObject({
    reasoning: true,
    input: ["text", "image"],
  });
  expect(resolveModel("anthropic/claude-sonnet-4-6").input).toEqual(["text", "image"]);
});

it("filters non-language models and preserves vision and legacy rows", async () => {
  const id = "alibaba/qwen3-235b-a22b-thinking";
  mockCatalog([
    { id, type: "language", tags: ["vision", "reasoning"] },
    { id: "alibaba/qwen3-embedding-0.6b", type: "embedding" },
    { id: "custom/legacy-model" },
  ]);

  expect((await buildProvider()).models).toMatchObject([
    { id, reasoning: true, input: ["text", "image"] },
    { id: "custom/legacy-model", input: ["text"] },
  ]);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "trusted_env_proxy", url: endpoint }),
  );
});

it("propagates a malformed model list row", async () => {
  const release = mockCatalog([null]);
  await expect(discoverVercelAiGatewayModels({ discoveryMode: "strict" })).rejects.toThrow(
    "Vercel AI Gateway model list: malformed JSON response",
  );
  expect(release).toHaveBeenCalledOnce();
});

it.each(["1e400", "1e308"])("normalizes limits and prices (%s)", async (price) => {
  // Keep the wire number: JSON.stringify would turn numeric Infinity into null.
  const release = mockResponse(
    new Response(`{"data":[
            {"id":"anthropic/claude-opus-4.6","name":"Opus","context_window":-1,"max_tokens":128000.5,"pricing":{"input":${price}}},
            {"id":"custom/partly-priced","context_window":1e400,"max_tokens":0,"pricing":{"input":${price},"output":0.000001}},
            {"id":"custom/valid","pricing":{"input":0.000002,"output":"3.5e-6","input_cache_read":"0x10","input_cache_write":-0.000001}}
          ]}`),
  );

  const models = await discoverVercelAiGatewayModels({ discoveryMode: "strict" });

  expect(models.map(({ id, cost }) => ({ id, cost }))).toEqual([
    pricedModel("anthropic/claude-opus-4.6", 5, 25, 0.5, 6.25),
    pricedModel("custom/partly-priced", 0, 1),
    pricedModel("custom/valid", 2, 3.5),
  ]);
  expect(models.slice(0, 2).map((m) => [m.contextWindow, m.maxTokens])).toEqual([
    [1_000_000, 128_000],
    [200_000, 128_000],
  ]);
  expect(release).toHaveBeenCalledOnce();
});

it("lists only scoped models using the configured key", async () => {
  const { registerSingleProviderPlugin } = await import("openclaw/plugin-sdk/plugin-test-runtime");
  const { default: plugin } = await import("./index.js");
  const provider = await registerSingleProviderPlugin(plugin);
  mockCatalog([{ id: "zai/glm-5.3", context_window: 1_000_000, max_tokens: 131_072 }]);

  const result = await provider.catalog?.run({
    config: {},
    resolveProviderApiKey: () => ({ apiKey: "scoped-key", discoveryApiKey: "scoped-key" }),
  } as never);

  const request = fetchMock.mock.calls[0]?.[0];
  expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer scoped-key");
  expect(result).toMatchObject({
    provider: { apiKey: "scoped-key", models: [{ id: "zai/glm-5.3" }] },
  });
});
