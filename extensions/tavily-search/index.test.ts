import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function createApi(params?: {
  config?: OpenClawPluginApi["config"];
  pluginConfig?: Record<string, unknown>;
}) {
  let registeredProvider: Parameters<OpenClawPluginApi["registerSearchProvider"]>[0] | undefined;
  const api = {
    id: "tavily-search",
    name: "Tavily Search",
    source: "/tmp/tavily-search/index.ts",
    config: params?.config ?? {},
    pluginConfig: params?.pluginConfig,
    runtime: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerSearchProvider: vi.fn((provider) => {
      registeredProvider = provider;
    }),
  } as unknown as OpenClawPluginApi;

  plugin.register?.(api);
  if (!registeredProvider) {
    throw new Error("search provider was not registered");
  }
  return registeredProvider;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("tavily-search plugin", () => {
  it("registers a tavily search provider and detects availability from plugin config", () => {
    const provider = createApi({
      config: {
        plugins: {
          entries: {
            "tavily-search": {
              config: {
                apiKey: "tvly-test-key",
              },
            },
          },
        },
      },
    });

    expect(provider.id).toBe("tavily");
    expect(provider.isAvailable?.({})).toBe(false);
    expect(
      provider.isAvailable?.({
        plugins: {
          entries: {
            "tavily-search": {
              config: {
                apiKey: "tvly-test-key",
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("maps Tavily responses into plugin search results", async () => {
    const provider = createApi({
      pluginConfig: {
        apiKey: "tvly-test-key",
        searchDepth: "advanced",
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        answer: "Tavily says hello",
        results: [
          {
            title: "Example",
            url: "https://example.com/article",
            content: "Snippet",
            published_date: "2026-03-10",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.search(
      {
        query: "hello",
        count: 3,
        country: "US",
        freshness: "week",
      },
      {
        config: {},
        timeoutSeconds: 5,
        cacheTtlMs: 1000,
        pluginConfig: {
          apiKey: "tvly-test-key",
          searchDepth: "advanced",
        },
      },
    );

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      api_key: "tvly-test-key",
      query: "hello",
      max_results: 3,
      search_depth: "advanced",
      topic: "news",
      days: 7,
      country: "US",
    });
    expect(result).toEqual({
      content: "Tavily says hello",
      citations: ["https://example.com/article"],
      results: [
        {
          title: "Example",
          url: "https://example.com/article",
          description: "Snippet",
          published: "2026-03-10",
        },
      ],
    });
  });
});
