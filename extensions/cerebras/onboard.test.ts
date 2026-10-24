import type { Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { captureProviderRequestPayload } from "../test-support/provider-request-payload.test-support.js";
import { buildCerebrasCatalogModels } from "./api.js";
import plugin from "./index.js";
import { applyCerebrasConfig, CEREBRAS_DEFAULT_MODEL_REF } from "./onboard.js";

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<LiveModelCatalogFetchGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  ...ssrfRuntimeMocks,
}));

const NATIVE_TEXT_MODEL = {
  id: "text",
  object: "model",
  name: "Text",
  pricing: { prompt: "0.00000035", completion: "0.00000075" },
  capabilities: { reasoning: true, vision: false, tools: true },
  limits: { max_context_length: 131072, max_completion_tokens: 40960 },
};

type CatalogContext = Parameters<NonNullable<ProviderPlugin["catalog"]>["run"]>[0];

const keys = { apiKey: "fixture-cerebras-key", discoveryApiKey: "fixture-discovery-key" };
const createCatalogContext = (): CatalogContext => ({
  config: {},
  env: {},
  resolveProviderApiKey: () => ({ ...keys, profileId: "cerebras:fixture-profile" }),
  resolveProviderAuth: () => ({ ...keys, mode: "api_key", source: "env" }),
});

function mockCatalogResponse(body: unknown, init?: ResponseInit) {
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }) => ({
    response: Response.json(body, init),
    finalUrl: url,
    release: async () => {},
  }));
}

async function runCerebrasCatalog() {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run(createCatalogContext());
  assert(result && "provider" in result, "expected authenticated Cerebras provider catalog");
  return result.provider;
}

function expectedCost(input: number, output: number) {
  return expect.objectContaining({
    input: expect.closeTo(input, 10),
    output: expect.closeTo(output, 10),
    cacheRead: expect.closeTo(input, 10),
    cacheWrite: 0,
  });
}

beforeEach(clearLiveCatalogCacheForTests);

afterEach(() => {
  clearLiveCatalogCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
});

it("selects the default and alias when seeding a replace-mode catalog", () => {
  const config = applyCerebrasConfig({ models: { mode: "replace" } });

  expect(config.models?.mode).toBe("replace");
  expect(config.models?.providers?.cerebras?.models).toEqual(buildCerebrasCatalogModels());
  const primary = resolveAgentModelPrimaryValue(config.agents?.defaults?.model);
  expect(primary).toBe("cerebras/gpt-oss-120b");
  expect(config.agents?.defaults?.models).toEqual({
    [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras GPT OSS 120B" },
  });
});

it.each([
  { pricing: NATIVE_TEXT_MODEL.pricing, cost: expectedCost(0.35, 0.75) },
  { pricing: { prompt: "0.00000035" }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
])("discovers credential-free native metadata with pricing $pricing", async ({ pricing, cost }) => {
  mockCatalogResponse({
    object: "list",
    data: [
      { ...NATIVE_TEXT_MODEL, pricing },
      {
        ...NATIVE_TEXT_MODEL,
        id: "vision",
        name: "Vision",
        pricing: { prompt: "0.00000099", completion: "0.00000149" },
        capabilities: { reasoning: false, vision: true, tools: true },
        limits: { max_context_length: 262144, max_completion_tokens: 65536 },
      },
    ],
  });

  const catalog = await runCerebrasCatalog();

  expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
  const request = ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls[0]?.[0];
  expect(request?.url).toBe("https://api.cerebras.ai/public/v1/models");
  const headers = new Headers(request?.init?.headers);
  expect([...headers]).toEqual([["accept", "application/json"]]);
  expect(catalog).toMatchObject({
    apiKey: "fixture-cerebras-key",
    api: "openai-completions",
    baseUrl: "https://api.cerebras.ai/v1",
  });
  const fields = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens"] as const;
  expect(catalog.models.map((model) => fields.map((field) => model[field]))).toEqual([
    ["text", "Text", true, ["text"], 131072, 40960],
    ["vision", "Vision", false, ["text", "image"], 262144, 65536],
  ]);
  expect(catalog.models.map((model) => model.cost)).toEqual([cost, expectedCost(0.99, 1.49)]);
});

it("reports unavailable discovery and recovers on the next request", async () => {
  mockCatalogResponse({ error: "unavailable" }, { status: 503 });
  const provider = await registerSingleProviderPlugin(plugin);
  await expect(provider.catalog?.run(createCatalogContext())).resolves.toEqual({
    providers: {},
    outcomes: [{ provider: "cerebras", status: "unavailable" }],
  });

  mockCatalogResponse({ data: [NATIVE_TEXT_MODEL] });
  const recovered = await runCerebrasCatalog();

  expect(recovered.models.map(({ id, cost }) => [id, cost])).toEqual([
    ["text", { input: 0.35, output: 0.75, cacheRead: 0.35, cacheWrite: 0 }],
  ]);
  expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
});

it.each([
  { baseUrl: "https://api.cerebras.ai/v1", key: "synthetic-session" },
  { baseUrl: "https://proxy.example/v1", key: undefined },
  { baseUrl: "https://api.cerebras.ai/v1", optOut: true, key: undefined },
])("sends native cache affinity at $baseUrl with optOut=$optOut", async (route) => {
  const provider = await registerSingleProviderPlugin(plugin);
  const model: Model = {
    id: "fixture-text-model",
    name: "Synthetic model",
    provider: "cerebras",
    api: "openai-completions",
    baseUrl: route.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 128,
    compat: route.optOut ? { supportsPromptCacheKey: false } : undefined,
  };
  const normalized =
    provider.normalizeResolvedModel?.({ provider: "cerebras", modelId: model.id, model }) ?? model;
  const { result, payload } = await captureProviderRequestPayload(normalized);
  expect(result.errorMessage).toBe("captured before request");
  expect(payload).toMatchObject({ prompt_cache_key: route.key });
  expect(payload).not.toHaveProperty("prompt_cache_retention");
  expect(payload).not.toHaveProperty("prompt_cache_options");
});
