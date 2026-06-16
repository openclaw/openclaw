import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  buildClawRouterProviderConfig,
  clearClawRouterCatalogForTests,
  normalizeClawRouterResolvedModel,
  resolveDiscoveredClawRouterModel,
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
      ],
      models: [
        {
          id: "google/gemini-default",
          upstream: "gemini",
          capabilities: ["llm.generate"],
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

function buildFetchGuard(): {
  fetchGuard: LiveModelCatalogFetchGuard;
  fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard>;
} {
  const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(CATALOG)),
    finalUrl: "https://clawrouter.example/v1/catalog",
    release: async () => undefined,
  }));
  return { fetchGuard: fetchGuardMock, fetchGuardMock };
}

describe("clawrouter provider catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    clearClawRouterCatalogForTests();
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
      authHeader: true,
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
      id: "claude-sonnet-4-5-20250929",
      api: "anthropic-messages",
      baseUrl: "https://clawrouter.example/v1/native/anthropic",
      headers: {
        Authorization: "Bearer clawrouter-test-key",
      },
    });

    const dynamic = resolveDiscoveredClawRouterModel({
      baseUrl: provider.baseUrl,
      modelId: "google/gemini-default",
    });
    expect(dynamic).toMatchObject({
      id: "google/gemini-default",
      provider: "clawrouter",
      api: "google-generative-ai",
    });
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

  it("replaces stale discovery state when the active catalog changes", async () => {
    const first = buildFetchGuard();
    const provider = await buildClawRouterProviderConfig({
      apiKey: "first-key",
      baseUrl: "https://first.example",
      fetchGuard: first.fetchGuard,
    });
    const anthropic = provider.models.find((model) => model.id === "anthropic/default");

    const second = buildFetchGuard();
    await buildClawRouterProviderConfig({
      apiKey: "second-key",
      baseUrl: "https://second.example",
      fetchGuard: second.fetchGuard,
    });

    expect(
      resolveDiscoveredClawRouterModel({
        baseUrl: "https://first.example/v1",
        modelId: "openai/gpt-5.5-mini",
      }),
    ).toBeUndefined();
    expect(
      resolveDiscoveredClawRouterModel({
        baseUrl: "https://second.example/v1",
        modelId: "openai/gpt-5.5-mini",
      }),
    ).toBeDefined();
    expect(
      normalizeClawRouterResolvedModel({
        ...anthropic,
        baseUrl: provider.baseUrl,
        provider: "clawrouter",
      } as ProviderRuntimeModel),
    ).toBeUndefined();
  });
});
