import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClawRouterProviderConfig,
  normalizeClawRouterResolvedModel,
  prepareClawRouterRequestModel,
} from "./provider-catalog.js";

const PRICING = {
  inputMicrosPerMillion: 3_000_000,
  outputMicrosPerMillion: 15_000_000,
  cachedInputMicrosPerMillion: 300_000,
  cacheWrite5mInputMicrosPerMillion: 3_750_000,
  maxInputTokens: 1_000_000,
  defaultMaxOutputTokens: 64_000,
};

function catalogProvider(
  id: string,
  displayName: string,
  upstream: string,
  capabilities: string[],
  routes: Array<[string, string]> = [],
  model: {
    id?: string;
    input?: unknown;
    supportedReasoningEfforts?: string[];
    pricing?: typeof PRICING;
  } = {},
) {
  return {
    id,
    displayName,
    openaiCompatible: id === "openai" || id === "deepseek",
    nativeBaseUrl: `/v1/native/${id}`,
    routes: routes.map(([path, requestFormat]) => ({ path, requestFormat, methods: ["POST"] })),
    models: [{ id: `${id}/${upstream}`, upstream, capabilities, ...model }],
  };
}

const CATALOG = {
  version: "clawrouter.client-catalog.v1",
  providers: [
    catalogProvider(
      "openai",
      "OpenAI",
      "gpt-5.6",
      ["llm.responses", "llm.chat"],
      [["/v1/responses", "openai.responses"]],
      {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        pricing: PRICING,
      },
    ),
    catalogProvider("deepseek", "DeepSeek", "deepseek-v4-flash", ["llm.chat"]),
    catalogProvider(
      "anthropic",
      "Anthropic",
      "claude-sonnet-4-6",
      ["llm.messages"],
      [["/v1/messages", "anthropic.messages"]],
      { pricing: PRICING },
    ),
    catalogProvider(
      "google-gemini",
      "Google Gemini",
      "gemini-3.5-flash",
      ["llm.generate", "llm.stream"],
      [
        ["/v1beta/models/${model}:generateContent", "google.generate_content"],
        ["/v1beta/models/${model}:streamGenerateContent", "google.generate_content"],
      ],
      { id: "google/gemini-3.5-flash" },
    ),
    catalogProvider(
      "cohere",
      "Cohere",
      "command-a-plus-05-2026",
      ["llm.chat"],
      [["/v2/chat", "cohere.chat"]],
    ),
  ],
};

function buildFetchGuard() {
  return vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async () => ({
    response: Response.json(CATALOG),
    finalUrl: "https://clawrouter.example/v1/catalog",
    release: async () => undefined,
  }));
}

describe("ClawRouter provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("maps every supported catalog protocol to its OpenClaw transport", async () => {
    const fetchGuard = buildFetchGuard();
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example/v1",
    });

    expect(fetchGuard).toHaveBeenCalledOnce();
    expect(provider.models.map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "deepseek/deepseek-v4-flash",
      "google/gemini-3.5-flash",
      "openai/gpt-5.6",
    ]);
    const openai = provider.models.find((model) => model.id === "openai/gpt-5.6");
    expect(openai).toMatchObject({
      name: "OpenAI · gpt-5.6",
      api: "openai-responses",
      baseUrl: "https://clawrouter.example/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expect(openai?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    expect(openai?.compat).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    });
    const deepseek = provider.models.find((model) => model.id === "deepseek/deepseek-v4-flash");
    expect(deepseek).toMatchObject({
      name: "DeepSeek · deepseek-v4-flash",
      api: "openai-completions",
    });
    expect(deepseek?.compat).toBeUndefined();
    expect(deepseek?.thinkingLevelMap).toBeUndefined();
    expect(
      provider.models.find((model) => model.id === "anthropic/claude-sonnet-4-6"),
    ).toMatchObject({
      name: "Anthropic · claude-sonnet-4-6",
      api: "anthropic-messages",
      baseUrl: "https://clawrouter.example/v1/native/anthropic",
    });
    expect(provider.models.find((model) => model.id === "google/gemini-3.5-flash")).toMatchObject({
      name: "Google Gemini · google/gemini-3.5-flash",
      api: "google-generative-ai",
      baseUrl: "https://clawrouter.example/v1/native/google-gemini/v1beta",
    });
  });

  it("retains known native image inputs without granting unknown OpenAI models", async () => {
    const upstreamIds = [
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-astra",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-6-unknown",
    ];
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async () => ({
      response: Response.json({
        providers: [
          ...upstreamIds.map((id) => catalogProvider("openai", "OpenAI", id, ["llm.responses"])),
          catalogProvider("deepseek", "DeepSeek", "gpt-6.1-sol", ["llm.chat"]),
        ],
      }),
      finalUrl: "https://clawrouter.example/v1/catalog",
      release: async () => undefined,
    }));
    const provider = await buildClawRouterProviderConfig({ apiKey: "fixture-key" });
    expect(Object.fromEntries(provider.models.map((model) => [model.id, model.input]))).toEqual({
      "openai/gpt-6.1-sol": ["text", "image"],
      "openai/gpt-6-sol": ["text", "image"],
      "openai/gpt-6-astra": ["text", "image"],
      "openai/gpt-4.1": ["text", "image"],
      "openai/gpt-4.1-mini": ["text", "image"],
      "openai/gpt-4.1-nano": ["text", "image"],
      "openai/gpt-6-unknown": ["text"],
      "deepseek/gpt-6.1-sol": ["text"],
    });
  });

  it("honors declared input before native facts or family heuristics and fails malformed input closed", async () => {
    const rows = [
      { id: "declared-vision", upstream: "unknown", input: ["text", "image"] },
      { id: "image-only", upstream: "unknown", input: ["image"] },
      { id: "text-sol", upstream: "gpt-6.1-sol", input: ["text"] },
      { id: "openai/gpt-5.6", upstream: "gpt-5.6", input: ["text"] },
      { id: "malformed-sol", upstream: "gpt-6.1-sol", input: "image" },
      { id: "empty-sol", upstream: "gpt-6.1-sol", input: [] },
      { id: "unknown-modality", upstream: "gpt-6.1-sol", input: ["image", "future"] },
      { id: "object-modality", upstream: "gpt-6.1-sol", input: ["image", {}] },
      { id: "null-modality", upstream: "gpt-6.1-sol", input: null },
    ];
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async () => ({
      response: Response.json({
        providers: rows.map(({ upstream, ...model }) =>
          catalogProvider("openai", "OpenAI", upstream, ["llm.responses"], [], model),
        ),
      }),
      finalUrl: "https://clawrouter.example/v1/catalog",
      release: async () => undefined,
    }));
    const provider = await buildClawRouterProviderConfig({ apiKey: "fixture-key" });
    expect(Object.fromEntries(provider.models.map((model) => [model.id, model.input]))).toEqual({
      "declared-vision": ["text", "image"],
      "image-only": ["image"],
      "text-sol": ["text"],
      "openai/gpt-5.6": ["text"],
      "malformed-sol": ["text"],
      "empty-sol": ["text"],
      "unknown-modality": ["text"],
      "object-modality": ["text"],
      "null-modality": ["text"],
    });
  });

  it("rewrites only native protocol model ids at the request boundary", async () => {
    buildFetchGuard();
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example",
    });
    const normalize = (id: string) =>
      normalizeClawRouterResolvedModel({
        ...provider.models.find((model) => model.id === id),
        baseUrl: provider.baseUrl,
        provider: "clawrouter",
      } as ProviderRuntimeModel);
    const normalized = normalize("anthropic/claude-sonnet-4-6");

    expect(normalized).toMatchObject({
      id: "anthropic/claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    expect(prepareClawRouterRequestModel(normalized as ProviderRuntimeModel)).toMatchObject({
      id: "claude-sonnet-4-6",
      params: undefined,
    });

    const normalizedOpenAi = normalize("openai/gpt-5.6");
    expect(prepareClawRouterRequestModel(normalizedOpenAi as ProviderRuntimeModel).id).toBe(
      "openai/gpt-5.6",
    );
  });

  it("validates catalog prices and limits while retaining the first supported duplicate", async () => {
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async () => ({
      response: Response.json({
        providers: [
          null,
          {
            ...catalogProvider("invalid", "Invalid", "model", ["llm.chat"]),
            nativeBaseUrl: "/wrong",
          },
          {
            ...catalogProvider("openai", "OpenAI", "model", ["llm.responses"]),
            models: [
              null,
              { id: "missing-upstream", capabilities: ["llm.responses"] },
              { id: "duplicate", upstream: "model", capabilities: ["audio.speech"] },
              {
                id: "duplicate",
                upstream: "model",
                displayName: "First",
                capabilities: ["llm.responses"],
                pricing: {
                  inputMicrosPerMillion: -1,
                  outputMicrosPerMillion: "3000000",
                  cachedInputMicrosPerMillion: 0,
                  cacheWrite5mInputMicrosPerMillion: -1,
                  cacheWrite1hInputMicrosPerMillion: 2_000_000,
                  maxInputTokens: 1.5,
                  defaultMaxOutputTokens: 0,
                  serviceTiers: [{ id: " priority " }, null, { id: "priority" }, { id: "default" }],
                },
              },
              {
                id: "duplicate",
                upstream: "model",
                displayName: "Later",
                capabilities: ["llm.responses"],
              },
              { id: "defaults", upstream: "model", capabilities: ["llm.chat"], pricing: null },
            ],
          },
        ],
      }),
      finalUrl: "https://clawrouter.example/v1/catalog",
      release: async () => undefined,
    }));

    const provider = await buildClawRouterProviderConfig({ apiKey: "fixture-key" });

    expect(provider.models.map((model) => model.id)).toEqual(["defaults", "duplicate"]);
    expect(provider.models[1]).toMatchObject({
      name: "First",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 2 },
      contextWindow: 200_000,
      maxTokens: 32_768,
      params: { clawrouterRoute: { serviceTiers: ["priority", "priority", "default"] } },
    });
    expect(provider.models[0]).toMatchObject({
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_768,
    });
    expect(provider.models[0]?.params?.clawrouterRoute).not.toHaveProperty("serviceTiers");
  });

  it("reuses granted models for an hour without mixing credentials or endpoints", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fetchGuard = buildFetchGuard();
    const params = {
      apiKey: "catalog-key-a",
      baseUrl: "https://clawrouter.example",
    };
    try {
      const first = await buildClawRouterProviderConfig(params);
      now.mockReturnValue(1_800_000_000_000 + 59 * 60_000);
      expect(await buildClawRouterProviderConfig(params)).toEqual(first);
      expect(fetchGuard).toHaveBeenCalledOnce();

      await buildClawRouterProviderConfig({ ...params, discoveryApiKey: "catalog-key-b" });
      await buildClawRouterProviderConfig({ ...params, baseUrl: "https://other.example" });
      expect(fetchGuard).toHaveBeenCalledTimes(3);
      const headers = fetchGuard.mock.calls[1]?.[0].init?.headers;
      expect(headers).toBeInstanceOf(Headers);
      expect((headers as Headers).get("authorization")).toBe("Bearer catalog-key-b");

      // A cache hit does not renew the original deadline indefinitely.
      now.mockReturnValue(1_800_000_000_000 + 60 * 60_000);
      await buildClawRouterProviderConfig(params);
      expect(fetchGuard).toHaveBeenCalledTimes(4);
    } finally {
      now.mockRestore();
    }
  });
});
