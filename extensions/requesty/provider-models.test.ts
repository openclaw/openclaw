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
  getStaticRequestyModelCatalog,
  isRequestyAnthropicModel,
  projectRequestyModels,
  REQUESTY_BASE_URL,
  REQUESTY_DEFAULT_MODEL_ID,
  REQUESTY_MODELS_URL,
} from "./api.js";
import plugin from "./index.js";

function makeRequestyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "claude-sonnet-4-6",
    api: "chat",
    input_price: 0.000003,
    output_price: 0.000015,
    cached_price: 3e-7,
    caching_price: 0.00000375,
    context_window: 1_000_000,
    max_output_tokens: 64_000,
    supports_vision: true,
    supports_reasoning: true,
    ...overrides,
  };
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return projectRequestyModels([makeRequestyRow(overrides)])[0];
}

function mockCatalog(payload: unknown, status = 200) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: jsonResponse(payload, status),
    release,
    finalUrl: REQUESTY_MODELS_URL,
  });
  return release;
}

const FIXTURE_API_KEY = "fixture-requesty-key";

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

it("returns fresh static rows on every call", () => {
  getStaticRequestyModelCatalog()[0]!.input.push("image");
  expect(getStaticRequestyModelCatalog()[0]?.input).toEqual(["text", "image"]);
});

it("projects per-token prices to per-million and maps capability flags", () => {
  expect(projectRow()).toEqual({
    id: "claude-sonnet-4-6",
    name: "claude-sonnet-4-6",
    reasoning: true,
    input: ["text", "image"],
    compat: { supportsReasoningEffort: true },
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  });
});

it("treats missing cache prices and capability flags as absent", () => {
  const model = projectRow({
    caching_price: undefined,
    supports_vision: false,
    supports_reasoning: undefined,
  });
  expect(model).toMatchObject({
    reasoning: false,
    input: ["text"],
    cost: { cacheWrite: 0 },
  });
  expect(model).not.toHaveProperty("compat");
});

it("skips non-chat, malformed, and duplicate rows without dropping later rows", () => {
  const models = projectRequestyModels([
    null,
    "not-a-row",
    { api: "chat", input_price: 1 },
    makeRequestyRow({ id: "text-embedding-3-large", api: "embeddings" }),
    makeRequestyRow({ id: "  " }),
    makeRequestyRow({ id: "claude-sonnet-4-6" }),
    makeRequestyRow({ id: "claude-sonnet-4-6", output_price: 99 }),
    makeRequestyRow({ id: "gemini-2.5-pro" }),
  ]);
  expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "gemini-2.5-pro"]);
  expect(models[0]?.cost.output).toBe(15);
});

it.each([
  [REQUESTY_DEFAULT_MODEL_ID, -1, 64_000.5],
  ["custom-policy", Number.POSITIVE_INFINITY, 0],
] as const)(
  "falls back from malformed token limits and prices for %s",
  (id, context, maxTokens) => {
    expect(
      projectRow({
        id,
        context_window: context,
        max_output_tokens: maxTokens,
        input_price: "1e400",
        output_price: "abc",
      }),
    ).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 0, output: 0 },
    });
  },
);

it("lists the caller's managed policies with the configured API key", async () => {
  const release = mockCatalog({
    data: [
      makeRequestyRow(),
      makeRequestyRow({ id: "claude-sonnet-4-6@eu" }),
      makeRequestyRow({ id: "bedrock/claude-sonnet-4-6@eu-central-1" }),
      makeRequestyRow({ id: "gpt-5.5" }),
    ],
  });
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run(catalogContext(FIXTURE_API_KEY));
  expect(result).toMatchObject({
    provider: {
      baseUrl: REQUESTY_BASE_URL,
      api: "openai-completions",
      apiKey: FIXTURE_API_KEY,
      models: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.5" }],
    },
  });
  expect(release).toHaveBeenCalledOnce();
  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
  expect(request.url).toBe("https://router.requesty.ai/v1/models/managed");
  expect(new Headers(request.init.headers).get("authorization")).toBe(`Bearer ${FIXTURE_API_KEY}`);
});

it("skips discovery until an API key is configured", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  await expect(provider.catalog?.run(catalogContext(undefined))).resolves.toBeNull();
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
});

it.each([
  [{ models: [] }, 200, "unavailable"],
  [{ error: "invalid key" }, 403, "auth-rejected"],
] as const)("reports %j (HTTP %s) as %s", async (payload, status, outcome) => {
  const provider = await registerSingleProviderPlugin(plugin);
  mockCatalog(payload, status);
  await expect(provider.catalog?.run(catalogContext(FIXTURE_API_KEY))).resolves.toMatchObject({
    providers: {},
    outcomes: [{ provider: "requesty", status: outcome }],
  });
});

it("does not mistake an anthropic hosting path for a Claude model", () => {
  expect(isRequestyAnthropicModel("deepinfra/anthropic-style/not-claude")).toBe(false);
});
