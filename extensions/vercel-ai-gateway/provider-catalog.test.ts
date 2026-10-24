import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

import { discoverVercelAiGatewayModels, VERCEL_AI_GATEWAY_BASE_URL } from "./api.js";
import {
  buildStaticVercelAiGatewayProvider as staticProvider,
  buildVercelAiGatewayProvider as buildProvider,
  resolveVercelAiGatewayModel as resolveModel,
} from "./provider-catalog.js";

function mockResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response,
    release,
    finalUrl: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
  });
  return release;
}

const mockCatalog = (data: unknown[], status = 200) => mockResponse(jsonResponse({ data }, status));
const tokenRow = (id: string, context_window: number, max_tokens: number) => ({
  id,
  name: id,
  context_window,
  max_tokens,
  tags: ["reasoning"],
});
const pricedModel = (id: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  id,
  cost: { input, output, cacheRead, cacheWrite },
});

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
});

it("falls back to the static provider on HTTP 503", async () => {
  const release = mockCatalog([], 503);
  await expect(buildProvider()).resolves.toEqual(staticProvider());
  expect(release).toHaveBeenCalledOnce();
});

it("preserves provider thinking metadata for known live-only upstream models", () => {
  expect([
    resolveModel("openai/gpt-5.5"),
    resolveModel("anthropic/claude-sonnet-4-6"),
  ]).toMatchObject([{ reasoning: true, input: ["text", "image"] }, { input: ["text", "image"] }]);
});

it("excludes non-language models while preserving vision and legacy catalog rows", async () => {
  const visionModelId = "alibaba/qwen3-235b-a22b-thinking";
  mockCatalog([
    { id: visionModelId, type: "language", tags: ["vision", "reasoning"] },
    { id: "alibaba/qwen3-embedding-0.6b", type: "embedding" },
    { id: "custom/legacy-model" },
  ]);

  expect((await buildProvider()).models).toMatchObject([
    { id: visionModelId, reasoning: true, input: ["text", "image"] },
    { id: "custom/legacy-model", input: ["text"] },
  ]);
  expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "trusted_env_proxy",
      url: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
    }),
  );
});

it("propagates a malformed model list row", async () => {
  const release = mockCatalog([null]);
  await expect(discoverVercelAiGatewayModels({ discoveryMode: "strict" })).rejects.toThrow(
    "Vercel AI Gateway model list: malformed JSON response",
  );
  expect(release).toHaveBeenCalledOnce();
});

it("falls back from malformed live token metadata", async () => {
  mockCatalog([
    tokenRow("anthropic/claude-opus-4.6", -1, 128_000.5),
    tokenRow("custom/provider-model", Number.POSITIVE_INFINITY, 0),
  ]);

  expect(
    (await discoverVercelAiGatewayModels()).map((m) => [m.id, m.contextWindow, m.maxTokens]),
  ).toEqual([
    ["anthropic/claude-opus-4.6", 1_000_000, 128_000],
    ["custom/provider-model", 200_000, 128_000],
  ]);
});

it.each(["1e400", "1e308"])(
  "falls back from overflowing live prices (%s) while preserving valid rates",
  async (price) => {
    // Keep the wire number: JSON.stringify would turn numeric Infinity into null.
    const release = mockResponse(
      new Response(
        `{"data":[
            {"id":"anthropic/claude-opus-4.6","pricing":{"input":${price}}},
            {"id":"custom/partly-priced","pricing":{"input":${price},"output":0.000001}},
            {"id":"custom/valid","pricing":{"input":0.000002,"output":"3.5e-6","input_cache_read":"0x10","input_cache_write":-0.000001}}
          ]}`,
        { headers: { "Content-Type": "application/json" } },
      ),
    );

    const models = await discoverVercelAiGatewayModels({ discoveryMode: "strict" });

    expect(models.map(({ id, cost }) => ({ id, cost }))).toEqual([
      pricedModel("anthropic/claude-opus-4.6", 5, 25, 0.5, 6.25),
      pricedModel("custom/partly-priced", 0, 1),
      pricedModel("custom/valid", 2, 3.5),
    ]);
    expect(release).toHaveBeenCalledOnce();
  },
);

it("lists models with the configured key so scoped keys see only their models", async () => {
  const { registerSingleProviderPlugin } = await import("openclaw/plugin-sdk/plugin-test-runtime");
  const { default: plugin } = await import("./index.js");
  const provider = await registerSingleProviderPlugin(plugin);
  mockCatalog([tokenRow("zai/glm-5.3", 1_000_000, 131_072)]);

  const result = await provider.catalog?.run({
    config: {},
    resolveProviderApiKey: () => ({ apiKey: "scoped-key", discoveryApiKey: "scoped-key" }),
  } as never);

  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
  expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer scoped-key");
  expect(result).toMatchObject({
    provider: { apiKey: "scoped-key", models: [{ id: "zai/glm-5.3" }] },
  });
});
