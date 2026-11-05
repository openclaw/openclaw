import type { Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { captureProviderRequestPayload } from "../test-support/provider-request-payload.test-support.js";
import { buildCerebrasCatalogModels } from "./api.js";
import plugin from "./index.js";
import { applyCerebrasConfig, CEREBRAS_DEFAULT_MODEL_REF } from "./onboard.js";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn<LiveModelCatalogFetchGuard>());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard,
}));

const NATIVE_TEXT_MODEL = {
  id: "text",
  object: "model",
  name: "Text",
  pricing: { prompt: "0.00000035", completion: "0.00000075" },
  capabilities: { reasoning: true, vision: false, tools: true },
  limits: { max_context_length: 131072, max_completion_tokens: 40960 },
};

async function runCerebrasCatalog(body: unknown, init?: ResponseInit) {
  fetchWithSsrFGuard.mockImplementation(async ({ url }) => ({
    response: Response.json(body, init),
    finalUrl: url,
    release: async () => {},
  }));
  const provider = await registerSingleProviderPlugin(plugin);
  const keys = { apiKey: "fixture-cerebras-key", discoveryApiKey: "fixture-discovery-key" };
  return provider.catalog?.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ ...keys, profileId: "cerebras:fixture-profile" }),
    resolveProviderAuth: () => ({ ...keys, mode: "api_key", source: "env" }),
  });
}

beforeEach(clearLiveCatalogCacheForTests);
afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuard.mockReset();
});

it("selects the default and alias while preserving replace mode", () => {
  const config = applyCerebrasConfig({ models: { mode: "replace" } });
  expect(config.models?.mode).toBe("replace");
  expect(config.models?.providers?.cerebras?.models).toEqual(buildCerebrasCatalogModels());
  expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
    "cerebras/gpt-oss-120b",
  );
  expect(config.agents?.defaults?.models).toEqual({
    [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras GPT OSS 120B" },
  });
});

it("discovers credential-free text and vision metadata, with incomplete pricing defaulting to zero", async () => {
  const result = await runCerebrasCatalog({
    data: [
      NATIVE_TEXT_MODEL,
      {
        ...NATIVE_TEXT_MODEL,
        id: "vision",
        name: "Vision",
        pricing: { prompt: "0.00000035" },
        capabilities: { reasoning: false, vision: true, tools: true },
        limits: { max_context_length: 262144, max_completion_tokens: 65536 },
      },
    ],
  });
  assert(result && "provider" in result);
  const catalog = result.provider;
  const request = fetchWithSsrFGuard.mock.calls[0]?.[0];
  expect(request?.url).toBe("https://api.cerebras.ai/public/v1/models");
  expect([...new Headers(request?.init?.headers)]).toEqual([["accept", "application/json"]]);
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
  expect(
    catalog.models.map(({ cost: c }) => [c.input, c.output, c.cacheRead, c.cacheWrite]),
  ).toEqual([
    [expect.closeTo(0.35, 10), expect.closeTo(0.75, 10), expect.closeTo(0.35, 10), 0],
    [0, 0, 0, 0],
  ]);
});

it("reports unavailable discovery and recovers on the next request", async () => {
  await expect(runCerebrasCatalog({ error: "unavailable" }, { status: 503 })).resolves.toEqual({
    providers: {},
    outcomes: [{ provider: "cerebras", status: "unavailable" }],
  });
  const recovered = await runCerebrasCatalog({ data: [NATIVE_TEXT_MODEL] });
  assert(recovered && "provider" in recovered);
  expect(recovered.provider.models.map(({ id }) => id)).toEqual(["text"]);
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
