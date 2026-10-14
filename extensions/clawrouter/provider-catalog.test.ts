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

const CATALOG = {
  version: "clawrouter.client-catalog.v1",
  providers: [
    {
      id: "openai",
      displayName: "OpenAI",
      openaiCompatible: true,
      nativeBaseUrl: "/v1/native/openai",
      routes: [
        {
          path: "/v1/responses",
          methods: ["POST"],
          requestFormat: "openai.responses",
        },
      ],
      models: [
        {
          id: "openai/gpt-5.6",
          upstream: "gpt-5.6",
          capabilities: ["llm.responses", "llm.chat"],
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
          pricing: PRICING,
        },
      ],
    },
    {
      id: "deepseek",
      displayName: "DeepSeek",
      openaiCompatible: true,
      nativeBaseUrl: "/v1/native/deepseek",
      routes: [],
      models: [
        {
          id: "deepseek/deepseek-v4-flash",
          upstream: "deepseek-v4-flash",
          capabilities: ["llm.chat"],
        },
      ],
    },
    {
      id: "anthropic",
      displayName: "Anthropic",
      openaiCompatible: false,
      nativeBaseUrl: "/v1/native/anthropic",
      routes: [
        {
          path: "/v1/messages",
          methods: ["POST"],
          requestFormat: "anthropic.messages",
        },
      ],
      models: [
        {
          id: "anthropic/claude-sonnet-4-6",
          upstream: "claude-sonnet-4-6",
          capabilities: ["llm.messages"],
          pricing: PRICING,
        },
      ],
    },
    {
      id: "google-gemini",
      displayName: "Google Gemini",
      openaiCompatible: false,
      nativeBaseUrl: "/v1/native/google-gemini",
      routes: [
        {
          path: "/v1beta/models/${model}:generateContent",
          methods: ["POST"],
          requestFormat: "google.generate_content",
        },
        {
          path: "/v1beta/models/${model}:streamGenerateContent",
          methods: ["POST"],
          requestFormat: "google.generate_content",
        },
      ],
      models: [
        {
          id: "google/gemini-3.5-flash",
          upstream: "gemini-3.5-flash",
          capabilities: ["llm.generate", "llm.stream"],
        },
      ],
    },
    {
      id: "cohere",
      displayName: "Cohere",
      openaiCompatible: false,
      nativeBaseUrl: "/v1/native/cohere",
      routes: [
        {
          path: "/v2/chat",
          methods: ["POST"],
          requestFormat: "cohere.chat",
        },
      ],
      models: [
        {
          id: "cohere/command-a-plus-05-2026",
          upstream: "command-a-plus-05-2026",
          capabilities: ["llm.chat"],
        },
      ],
    },
  ],
};

function buildFetchGuard(catalog: unknown = CATALOG): {
  fetchGuard: LiveModelCatalogFetchGuard;
  fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard>;
} {
  const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(catalog)),
    finalUrl: "https://clawrouter.example/v1/catalog",
    release: async () => undefined,
  }));
  return { fetchGuard: fetchGuardMock, fetchGuardMock };
}

describe("ClawRouter provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("maps every supported catalog protocol to its OpenClaw transport", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard();
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example/v1",
      fetchGuard,
    });

    expect(fetchGuardMock).toHaveBeenCalledOnce();
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
      fetchGuard: buildFetchGuard().fetchGuard,
    });
    const anthropic = provider.models.find((model) => model.id === "anthropic/claude-sonnet-4-6");
    const normalized = normalizeClawRouterResolvedModel({
      ...anthropic,
      baseUrl: provider.baseUrl,
      provider: "clawrouter",
    } as ProviderRuntimeModel);

    expect(normalized).toMatchObject({
      id: "anthropic/claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    expect(prepareClawRouterRequestModel(normalized as ProviderRuntimeModel)).toMatchObject({
      id: "claude-sonnet-4-6",
      params: undefined,
    });

    const openaiModel = provider.models.find((model) => model.id === "openai/gpt-5.6");
    const normalizedOpenAi = normalizeClawRouterResolvedModel({
      ...openaiModel,
      baseUrl: provider.baseUrl,
      provider: "clawrouter",
    } as ProviderRuntimeModel);
    expect(prepareClawRouterRequestModel(normalizedOpenAi as ProviderRuntimeModel).id).toBe(
      "openai/gpt-5.6",
    );
  });

  it.each([["granted models", CATALOG]])(
    "reuses %s for an hour without mixing credentials or endpoints",
    async (_label, catalog) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const { fetchGuard, fetchGuardMock } = buildFetchGuard(catalog);
      const params = {
        apiKey: "catalog-key-a",
        baseUrl: "https://clawrouter.example",
        fetchGuard,
      };
      try {
        const first = await buildClawRouterProviderConfig(params);
        now.mockReturnValue(1_800_000_000_000 + 59 * 60_000);
        expect(await buildClawRouterProviderConfig(params)).toEqual(first);
        expect(fetchGuardMock).toHaveBeenCalledOnce();

        await buildClawRouterProviderConfig({ ...params, discoveryApiKey: "catalog-key-b" });
        await buildClawRouterProviderConfig({ ...params, baseUrl: "https://other.example" });
        expect(fetchGuardMock).toHaveBeenCalledTimes(3);
        const headers = fetchGuardMock.mock.calls[1]?.[0].init?.headers;
        expect(headers).toBeInstanceOf(Headers);
        expect((headers as Headers).get("authorization")).toBe("Bearer catalog-key-b");

        // A cache hit does not renew the original deadline indefinitely.
        now.mockReturnValue(1_800_000_000_000 + 60 * 60_000);
        await buildClawRouterProviderConfig(params);
        expect(fetchGuardMock).toHaveBeenCalledTimes(4);
      } finally {
        now.mockRestore();
      }
    },
  );
});
