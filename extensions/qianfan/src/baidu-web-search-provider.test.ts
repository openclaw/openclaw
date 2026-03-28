import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { __testing, createBaiduWebSearchProvider } from "./baidu-web-search-provider.js";

describe("baidu web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("registers the Baidu web search provider from the Qianfan plugin", () => {
    const registrations: { providers: unknown[] } = { providers: [] };

    plugin.register({
      registerProvider() {},
      registerWebSearchProvider(provider: unknown) {
        registrations.providers.push(provider);
      },
      config: {},
    } as never);

    expect(plugin.id).toBe("qianfan");
    expect(registrations.providers).toHaveLength(1);

    const provider = registrations.providers[0] as Record<string, unknown>;
    expect(provider.id).toBe("baidu");
    expect(provider.autoDetectOrder).toBe(55);
    expect(provider.envVars).toEqual(["QIANFAN_API_KEY"]);
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createBaiduWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("baidu");
    expect(provider.credentialPath).toBe("plugins.entries.qianfan.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.qianfan?.enabled).toBe(true);
  });

  it("prefers scoped configured API keys over environment fallbacks", () => {
    expect(__testing.resolveBaiduApiKey({ apiKey: "bce-v3/configured" })).toBe("bce-v3/configured");
  });

  it("defaults to direct mode and the documented smart-search model", () => {
    expect(__testing.resolveBaiduMode()).toBe("direct");
    expect(__testing.resolveBaiduMode({ mode: "smart" })).toBe("smart");
    expect(__testing.resolveBaiduSmartModel()).toBe("ernie-4.5-turbo-32k");
  });

  it("maps direct search references into structured results", async () => {
    vi.stubEnv("QIANFAN_API_KEY", "bce-v3/test-key");
    const mockFetch = vi.fn(async (_input?: unknown, init?: unknown) => {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            request_id: "req-1",
            references: [
              {
                title: "北京旅游攻略",
                url: "https://example.com/beijing",
                snippet: "故宫、长城、颐和园",
                date: "2026-03-28 10:00:00",
                website: "example.com",
                type: "web",
              },
            ],
          }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBaiduWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        baidu: { apiKey: "bce-v3/configured" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "北京景点",
      count: 3,
    });

    expect(result).toMatchObject({
      provider: "baidu",
      mode: "direct",
      results: [
        {
          url: "https://example.com/beijing",
          published: "2026-03-28 10:00:00",
          siteName: "example.com",
        },
      ],
    });

    const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(requestInit?.body));
    expect(body).toMatchObject({
      search_source: "baidu_search_v2",
      search_mode: "required",
      stream: false,
      resource_type_filter: [{ type: "web", top_k: 3 }],
    });
    expect(requestInit?.headers).toMatchObject({
      "X-Appbuilder-Authorization": "Bearer bce-v3/configured",
    });
  });

  it("maps smart search responses into wrapped content with citations", async () => {
    vi.stubEnv("QIANFAN_API_KEY", "bce-v3/test-key");
    const mockFetch = vi.fn(async (_input?: unknown, init?: unknown) => {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "北京推荐故宫、长城和颐和园。",
                },
              },
            ],
            references: [
              {
                title: "故宫博物院",
                url: "https://example.com/gugong",
                content: "故宫简介",
                website: "example.com",
                type: "web",
              },
            ],
          }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createBaiduWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        baidu: { apiKey: "bce-v3/configured", mode: "smart", model: "ernie-4.5-turbo-32k" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "北京景点",
      count: 2,
    });

    expect(result).toMatchObject({
      provider: "baidu",
      mode: "smart",
      model: "ernie-4.5-turbo-32k",
      citations: [{ url: "https://example.com/gugong", title: "故宫博物院" }],
    });

    const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(requestInit?.body));
    expect(body).toMatchObject({
      model: "ernie-4.5-turbo-32k",
      search_mode: "required",
      enable_reasoning: false,
      enable_deep_search: false,
      resource_type_filter: [{ type: "web", top_k: 2 }],
    });
  });

  it("returns a missing-key payload when no Qianfan key is available", async () => {
    const provider = createBaiduWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        baidu: {},
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "北京景点" });

    expect(result).toMatchObject({
      error: "missing_baidu_api_key",
    });
  });

  it("rejects unsupported generic web filters", async () => {
    const provider = createBaiduWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        baidu: { apiKey: "bce-v3/configured" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "北京景点",
      freshness: "week",
    });

    expect(result).toMatchObject({
      error: "unsupported_freshness",
    });
  });
});
