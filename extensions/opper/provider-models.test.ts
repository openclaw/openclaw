import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({ fetchWithSsrFGuardMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  OPPER_BASE_URL,
  OPPER_DEFAULT_MODEL_ID,
  OPPER_MODELS_URL,
  projectOpperModels,
} from "./api.js";
import plugin from "./index.js";

function makeOpperRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-sonnet-4-6",
    object: "model",
    created: 0,
    owned_by: "opper",
    context_length: 1_000_000,
    architecture: {
      modality: "text+image->text",
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
    },
    opper: {
      kind: "pool",
      type: "llm",
      capabilities: ["text", "vision", "tools", "reasoning"],
      max_output_tokens: 64_000,
    },
    ...overrides,
  };
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return projectOpperModels([makeOpperRow(overrides)])[0];
}

function mockCatalog(payload: unknown, status = 200) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: jsonResponse(payload, status),
    release,
    finalUrl: OPPER_MODELS_URL,
  });
  return release;
}

const FIXTURE_API_KEY = "fixture-opper-key";

function catalogContext(apiKey: string | undefined): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey }),
    resolveProviderAuth: () => ({ apiKey, mode: "api_key", source: "profile" }),
  };
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
});

it("projects per-token prices to per-million and maps capability flags", () => {
  expect(projectRow()).toEqual({
    id: "claude-sonnet-4-6",
    name: "claude-sonnet-4-6",
    reasoning: true,
    input: ["text", "image"],
    compat: { supportsReasoningEffort: true, supportsUsageInStreaming: true },
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  });
});

it("treats missing cache prices and capability flags as absent", () => {
  const model = projectRow({
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000003", completion: "0.000015" },
    opper: { type: "llm", capabilities: ["text"] },
  });
  expect(model).toMatchObject({
    reasoning: false,
    input: ["text"],
    cost: { cacheWrite: 0 },
  });
  expect(model?.compat).toEqual({ supportsUsageInStreaming: true });
});

it("keeps an unpriced row free and leaves out a row whose prices do not parse", () => {
  const models = projectOpperModels([
    makeOpperRow({ id: "free-model", pricing: undefined }),
    makeOpperRow({ id: "bad-price", pricing: { prompt: "unknown", completion: "0.000015" } }),
    makeOpperRow({ id: "gpt-6-luna" }),
  ]);
  expect(models.map((model) => model.id)).toEqual(["free-model", "gpt-6-luna"]);
  expect(models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

it("skips non-chat, malformed, and duplicate rows without dropping later rows", () => {
  const models = projectOpperModels([
    null,
    "not-a-row",
    { object: "model", context_length: 1 },
    makeOpperRow({ id: "text-embedding-3-large", opper: { type: "embedding" } }),
    makeOpperRow({
      id: "gpt-image-2",
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    }),
    makeOpperRow({ id: "  " }),
    makeOpperRow({ id: "claude-sonnet-4-6" }),
    makeOpperRow({ id: "claude-sonnet-4-6", pricing: { prompt: "1", completion: "1" } }),
    makeOpperRow({ id: "gemini-3.8-flash" }),
  ]);
  expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "gemini-3.8-flash"]);
  expect(models[0]?.cost.output).toBe(15);
});

it.each([
  [OPPER_DEFAULT_MODEL_ID, -1, 64_000.5],
  ["custom-route", Number.POSITIVE_INFINITY, 0],
] as const)("falls back from malformed token limits for %s", (id, context, maxTokens) => {
  expect(
    projectRow({
      id,
      context_length: context,
      opper: { type: "llm", capabilities: [], max_output_tokens: maxTokens },
    }),
  ).toMatchObject({
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  });
});

it("lists the caller's models once each with the configured API key", async () => {
  const release = mockCatalog({
    object: "list",
    data: [
      makeOpperRow(),
      makeOpperRow({ id: "text-embedding-3-large", opper: { type: "embedding" } }),
      makeOpperRow({ id: "gpt-6-luna" }),
    ],
  });
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run(catalogContext(FIXTURE_API_KEY));
  expect(result).toMatchObject({
    provider: {
      baseUrl: OPPER_BASE_URL,
      api: "openai-completions",
      apiKey: FIXTURE_API_KEY,
      models: [{ id: "claude-sonnet-4-6" }, { id: "gpt-6-luna" }],
    },
  });
  expect(release).toHaveBeenCalledOnce();
  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
  expect(request.url).toBe("https://api.opper.ai/v3/compat/models?view=simplified");
  expect(new Headers(request.init.headers).get("authorization")).toBe(`Bearer ${FIXTURE_API_KEY}`);
});

it("skips discovery until an API key is configured", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  await expect(provider.catalog?.run(catalogContext(undefined))).resolves.toBeNull();
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
});

it.each([
  [{ models: [] }, 200, "unavailable"],
  [{ error: "invalid key" }, 401, "auth-rejected"],
] as const)("reports %j (HTTP %s) as %s", async (payload, status, outcome) => {
  const provider = await registerSingleProviderPlugin(plugin);
  mockCatalog(payload, status);
  await expect(provider.catalog?.run(catalogContext(FIXTURE_API_KEY))).resolves.toMatchObject({
    providers: {},
    outcomes: [{ provider: "opper", status: outcome }],
  });
});
