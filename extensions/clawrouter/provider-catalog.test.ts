import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
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
  model: { id?: string; supportedReasoningEfforts?: string[]; pricing?: typeof PRICING } = {},
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

function buildFetchGuard(): MockedFunction<LiveModelCatalogFetchGuard> {
  return vi.fn(async () => ({
    response: Response.json(CATALOG),
    finalUrl: "https://clawrouter.example/v1/catalog",
    release: async () => undefined,
  }));
}

describe("ClawRouter provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("maps every supported catalog protocol to its OpenClaw transport", async () => {
    const fetchGuard = buildFetchGuard();
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example/v1",
      fetchGuard,
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
    expect(provider.models.map((model) => model.id)).not.toContain("cohere/command-a-plus-05-2026");
  });

  it("rewrites only native protocol model ids at the request boundary", async () => {
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example",
      fetchGuard: buildFetchGuard(),
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

  it("reuses granted models for an hour without mixing credentials or endpoints", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fetchGuard = buildFetchGuard();
    const params = {
      apiKey: "catalog-key-a",
      baseUrl: "https://clawrouter.example",
      fetchGuard,
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
