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
          responseFormat: "openai.responses",
        },
      ],
      models: [
        {
          id: "openai/gpt-5.5-mini",
          upstream: "gpt-5.5-mini",
          capabilities: ["llm.responses", "llm.chat"],
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
          responseFormat: "anthropic.messages",
        },
      ],
      models: [
        {
          id: "anthropic/default",
          upstream: "claude-sonnet-4-5-20250929",
          capabilities: ["llm.messages"],
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
          responseFormat: "google.generate_content",
        },
        {
          path: "/v1beta/models/${model}:streamGenerateContent",
          methods: ["POST"],
          requestFormat: "google.generate_content",
          responseFormat: "google.generate_content",
        },
      ],
      models: [
        {
          id: "google/gemini-default",
          upstream: "gemini",
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
          responseFormat: "cohere.chat",
        },
      ],
      models: [
        {
          id: "cohere/default",
          upstream: "command-a",
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

describe("clawrouter provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("maps credential-scoped catalog rows to their real provider transports", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard();
    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example/v1",
      fetchGuard,
    });

    expect(fetchGuardMock).toHaveBeenCalledOnce();
    expect(provider).toMatchObject({
      api: "openai-responses",
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example/v1",
    });
    expect(provider.models.map((model) => model.id)).toEqual([
      "anthropic/default",
      "google/gemini-default",
      "openai/gpt-5.5-mini",
    ]);

    expect(provider.models.find((model) => model.id === "openai/gpt-5.5-mini")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://clawrouter.example/v1",
    });
    expect(provider.models.find((model) => model.id === "anthropic/default")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://clawrouter.example/v1/native/anthropic",
    });
    expect(provider.models.find((model) => model.id === "google/gemini-default")).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://clawrouter.example/v1/native/google-gemini/v1beta",
    });

    const anthropic = provider.models.find((model) => model.id === "anthropic/default");
    const normalized = normalizeClawRouterResolvedModel({
      ...anthropic,
      baseUrl: provider.baseUrl,
      provider: "clawrouter",
    } as ProviderRuntimeModel);
    expect(normalized).toMatchObject({
      id: "anthropic/default",
      api: "anthropic-messages",
      baseUrl: "https://clawrouter.example/v1/native/anthropic",
    });
    expect(prepareClawRouterRequestModel(normalized as ProviderRuntimeModel)).toMatchObject({
      id: "claude-sonnet-4-5-20250929",
      params: undefined,
    });
    const gemini = provider.models.find((model) => model.id === "google/gemini-default");
    const normalizedGemini = normalizeClawRouterResolvedModel({
      ...gemini,
      baseUrl: provider.baseUrl,
      provider: "clawrouter",
    } as ProviderRuntimeModel);
    expect(normalizedGemini).toMatchObject({
      id: "google/gemini-default",
      api: "google-generative-ai",
      baseUrl: "https://clawrouter.example/v1/native/google-gemini/v1beta",
    });
    expect(prepareClawRouterRequestModel(normalizedGemini as ProviderRuntimeModel)).toMatchObject({
      id: "gemini",
      params: undefined,
    });
    expect(JSON.stringify(provider.models)).not.toContain("clawrouter-test-key");
  });

  it("caches the auth-scoped catalog for the discovery TTL", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard();
    const params = {
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example",
      fetchGuard,
    };

    await buildClawRouterProviderConfig(params);
    await buildClawRouterProviderConfig(params);

    expect(fetchGuardMock).toHaveBeenCalledOnce();
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer clawrouter-test-key");
  });

  it("does not advertise Gemini models without an explicit streaming route", async () => {
    const generateOnlyCatalog = structuredClone(CATALOG);
    generateOnlyCatalog.providers[2].routes = generateOnlyCatalog.providers[2].routes.filter(
      (route) => !route.path.includes(":streamGenerateContent"),
    );
    generateOnlyCatalog.providers[2].models[0].capabilities = ["llm.generate"];
    const { fetchGuard } = buildFetchGuard(generateOnlyCatalog);

    const provider = await buildClawRouterProviderConfig({
      apiKey: "clawrouter-test-key",
      baseUrl: "https://clawrouter.example",
      fetchGuard,
    });

    expect(provider.models.map((model) => model.id)).not.toContain("google/gemini-default");
  });

  it("keeps credential-scoped route metadata isolated on each catalog result", async () => {
    const firstCatalog = structuredClone(CATALOG);
    firstCatalog.providers[1].models[0].upstream = "first-upstream";
    const first = buildFetchGuard(firstCatalog);
    const firstProvider = await buildClawRouterProviderConfig({
      apiKey: "first-key",
      baseUrl: "https://clawrouter.example",
      fetchGuard: first.fetchGuard,
    });
    const firstAnthropic = firstProvider.models.find((model) => model.id === "anthropic/default");

    const secondCatalog = structuredClone(CATALOG);
    secondCatalog.providers[1].models[0].upstream = "second-upstream";
    const second = buildFetchGuard(secondCatalog);
    const secondProvider = await buildClawRouterProviderConfig({
      apiKey: "second-key",
      baseUrl: "https://clawrouter.example",
      fetchGuard: second.fetchGuard,
    });
    const secondAnthropic = secondProvider.models.find((model) => model.id === "anthropic/default");

    expect(
      prepareClawRouterRequestModel(
        normalizeClawRouterResolvedModel({
          ...firstAnthropic,
          baseUrl: firstProvider.baseUrl,
          provider: "clawrouter",
        } as ProviderRuntimeModel) as ProviderRuntimeModel,
      ).id,
    ).toBe("first-upstream");
    expect(
      prepareClawRouterRequestModel(
        normalizeClawRouterResolvedModel({
          ...secondAnthropic,
          baseUrl: secondProvider.baseUrl,
          provider: "clawrouter",
        } as ProviderRuntimeModel) as ProviderRuntimeModel,
      ).id,
    ).toBe("second-upstream");
  });
});
