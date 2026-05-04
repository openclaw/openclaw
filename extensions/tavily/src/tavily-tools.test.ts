import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TAVILY_BASE_URL,
  DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS,
  DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS,
  resolveTavilyApiKey,
  resolveTavilyBaseUrl,
  resolveTavilyExtractTimeoutSeconds,
  resolveTavilyFetchApiKey,
  resolveTavilyFetchBaseUrl,
  resolveTavilySearchConfig,
  resolveTavilySearchTimeoutSeconds,
} from "./config.js";

const { runTavilySearch, runTavilyExtract } = vi.hoisted(() => ({
  runTavilySearch: vi.fn(async (params: Record<string, unknown>) => params),
  runTavilyExtract: vi.fn(
    async (params: unknown): Promise<Record<string, unknown>> => ({ ok: true, params }),
  ),
}));

vi.mock("./tavily-client.js", () => ({
  runTavilySearch,
  runTavilyExtract,
}));

function fakeApi(): OpenClawPluginApi {
  return {
    config: {},
  } as OpenClawPluginApi;
}

describe("tavily tools", () => {
  let createTavilyWebSearchProvider: typeof import("./tavily-search-provider.js").createTavilyWebSearchProvider;
  let createTavilyWebFetchProvider: typeof import("./tavily-fetch-provider.js").createTavilyWebFetchProvider;
  let TAVILY_WEB_FETCH_PROVIDER_SHARED: typeof import("./tavily-fetch-provider-shared.js").TAVILY_WEB_FETCH_PROVIDER_SHARED;
  let createTavilySearchTool: typeof import("./tavily-search-tool.js").createTavilySearchTool;
  let createTavilyExtractTool: typeof import("./tavily-extract-tool.js").createTavilyExtractTool;
  let tavilyClientTesting: typeof import("./tavily-client.js").__testing;

  beforeAll(async () => {
    ({ createTavilyWebSearchProvider } = await import("./tavily-search-provider.js"));
    ({ createTavilyWebFetchProvider } = await import("./tavily-fetch-provider.js"));
    ({ TAVILY_WEB_FETCH_PROVIDER_SHARED } = await import("./tavily-fetch-provider-shared.js"));
    ({ createTavilySearchTool } = await import("./tavily-search-tool.js"));
    ({ createTavilyExtractTool } = await import("./tavily-extract-tool.js"));
    ({ __testing: tavilyClientTesting } =
      await vi.importActual<typeof import("./tavily-client.js")>("./tavily-client.js"));
  });

  beforeEach(() => {
    runTavilySearch.mockReset();
    runTavilySearch.mockImplementation(async (params: Record<string, unknown>) => params);
    runTavilyExtract.mockReset();
    runTavilyExtract.mockImplementation(
      async (params: unknown): Promise<Record<string, unknown>> => ({ ok: true, params }),
    );
    vi.unstubAllEnvs();
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createTavilyWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("tavily");
    expect(provider.credentialPath).toBe("plugins.entries.tavily.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("maps generic provider args into Tavily search params", async () => {
    const provider = createTavilyWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "weather sf",
      count: 7,
    });

    expect(runTavilySearch).toHaveBeenCalledWith({
      cfg: { test: true },
      query: "weather sf",
      maxResults: 7,
    });
    expect(result).toEqual({
      cfg: { test: true },
      query: "weather sf",
      maxResults: 7,
    });
  });

  it("normalizes optional parameters before invoking Tavily", async () => {
    runTavilySearch.mockImplementationOnce(async (params: Record<string, unknown>) => ({
      ok: true,
      params,
    }));
    const tool = createTavilySearchTool({
      config: { env: "test" },
    } as never);

    const result = await tool.execute("call-1", {
      query: "best docs",
      search_depth: "advanced",
      topic: "news",
      max_results: 5,
      include_answer: true,
      time_range: "week",
      include_domains: ["docs.openclaw.ai", "", "openclaw.ai"],
      exclude_domains: ["bad.example", ""],
    });

    expect(runTavilySearch).toHaveBeenCalledWith({
      cfg: { env: "test" },
      query: "best docs",
      searchDepth: "advanced",
      topic: "news",
      maxResults: 5,
      includeAnswer: true,
      timeRange: "week",
      includeDomains: ["docs.openclaw.ai", "openclaw.ai"],
      excludeDomains: ["bad.example"],
    });
    expect(result).toMatchObject({
      details: {
        ok: true,
        params: {
          cfg: { env: "test" },
          query: "best docs",
          searchDepth: "advanced",
          topic: "news",
          maxResults: 5,
          includeAnswer: true,
          timeRange: "week",
          includeDomains: ["docs.openclaw.ai", "openclaw.ai"],
          excludeDomains: ["bad.example"],
        },
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
    });
  });

  it("drops empty domain arrays and forwards query-scoped chunking", async () => {
    runTavilySearch.mockImplementationOnce(async (params: Record<string, unknown>) => ({
      ok: true,
      params,
    }));
    const searchTool = createTavilySearchTool({
      config: { env: "test" },
    } as never);

    await expect(
      searchTool.execute("call-2", {
        query: "simple",
        include_domains: [""],
        exclude_domains: [],
      }),
    ).resolves.toMatchObject({
      details: {
        ok: true,
        params: {
          cfg: { env: "test" },
          query: "simple",
          includeAnswer: false,
        },
      },
    });

    const extractTool = createTavilyExtractTool(fakeApi());
    await extractTool.execute("id", {
      urls: ["https://example.com"],
      query: "pricing",
      chunks_per_source: 2,
    });

    expect(runTavilyExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        urls: ["https://example.com"],
        query: "pricing",
        chunksPerSource: 2,
      }),
    );
  });

  it("rejects chunks_per_source without query", async () => {
    const tool = createTavilyExtractTool(fakeApi());

    await expect(
      tool.execute("id", {
        urls: ["https://example.com"],
        chunks_per_source: 2,
      }),
    ).rejects.toThrow("tavily_extract requires query when chunks_per_source is set.");

    expect(runTavilyExtract).not.toHaveBeenCalled();
  });

  it("reads plugin web search config and prefers it over env defaults", () => {
    vi.stubEnv("TAVILY_API_KEY", "env-key");
    vi.stubEnv("TAVILY_BASE_URL", "https://env.tavily.test");

    const cfg = {
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: "plugin-key",
                baseUrl: "https://plugin.tavily.test",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveTavilySearchConfig(cfg)).toEqual({
      apiKey: "plugin-key",
      baseUrl: "https://plugin.tavily.test",
    });
    expect(resolveTavilyApiKey(cfg)).toBe("plugin-key");
    expect(resolveTavilyBaseUrl(cfg)).toBe("https://plugin.tavily.test");
  });

  it("falls back to environment values and defaults", () => {
    vi.stubEnv("TAVILY_API_KEY", "env-key");
    vi.stubEnv("TAVILY_BASE_URL", "https://env.tavily.test");

    expect(resolveTavilyApiKey()).toBe("env-key");
    expect(resolveTavilyBaseUrl()).toBe("https://env.tavily.test");
    expect(resolveTavilyBaseUrl({} as OpenClawConfig)).not.toBe(DEFAULT_TAVILY_BASE_URL);
    expect(resolveTavilySearchTimeoutSeconds()).toBe(DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS);
    expect(resolveTavilyExtractTimeoutSeconds()).toBe(DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS);
  });

  it("accepts positive numeric timeout overrides and floors them", () => {
    expect(resolveTavilySearchTimeoutSeconds(19.9)).toBe(19);
    expect(resolveTavilyExtractTimeoutSeconds(42.7)).toBe(42);
    expect(resolveTavilySearchTimeoutSeconds(0)).toBe(DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS);
    expect(resolveTavilyExtractTimeoutSeconds(Number.NaN)).toBe(
      DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS,
    );
  });

  it("appends endpoints to reverse-proxy base urls", () => {
    expect(tavilyClientTesting.resolveEndpoint("https://proxy.example/api/tavily", "/search")).toBe(
      "https://proxy.example/api/tavily/search",
    );
    expect(
      tavilyClientTesting.resolveEndpoint("https://proxy.example/api/tavily/", "/extract"),
    ).toBe("https://proxy.example/api/tavily/extract");
  });

  it("falls back to the default host for invalid base urls", () => {
    expect(tavilyClientTesting.resolveEndpoint("not a url", "/search")).toBe(
      "https://api.tavily.com/search",
    );
    expect(tavilyClientTesting.resolveEndpoint("", "/extract")).toBe(
      "https://api.tavily.com/extract",
    );
  });

  it("exposes the expected metadata for the web-fetch provider", () => {
    const provider = createTavilyWebFetchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("tavily");
    expect(provider.autoDetectOrder).toBe(70);
    expect(provider.credentialPath).toBe("plugins.entries.tavily.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("maps generic web_fetch args into Tavily extract params and translates extractMode to format", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("TAVILY_BASE_URL", "");
    const provider = createTavilyWebFetchProvider();
    const markdownTool = provider.createTool({
      config: { test: true } as unknown as OpenClawConfig,
    });
    const textTool = provider.createTool({
      config: {} as OpenClawConfig,
    });
    if (!markdownTool || !textTool) {
      throw new Error("Expected tool definitions");
    }

    await markdownTool.execute({ url: "https://example.com" });
    expect(runTavilyExtract).toHaveBeenLastCalledWith({
      cfg: { test: true },
      urls: ["https://example.com"],
      format: "markdown",
      extractDepth: "advanced",
      baseUrl: DEFAULT_TAVILY_BASE_URL,
    });

    await textTool.execute({
      url: "https://example.com",
      extractMode: "text",
      proxy: "stealth",
      storeInCache: false,
    });
    expect(runTavilyExtract).toHaveBeenLastCalledWith({
      cfg: {},
      urls: ["https://example.com"],
      format: "text",
      extractDepth: "advanced",
      baseUrl: DEFAULT_TAVILY_BASE_URL,
    });
  });

  it("returns a flat top-level shape that the core fallback normalizer can consume", async () => {
    runTavilyExtract.mockImplementationOnce(async (params: unknown) => ({
      provider: "tavily",
      tookMs: 42,
      results: [
        {
          url: "https://example.com/canonical",
          rawContent: "ABCDEFGHIJ",
          content: "short",
        },
      ],
      _params: params,
    }));
    const tool = createTavilyWebFetchProvider().createTool({
      config: {} as OpenClawConfig,
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({ url: "https://example.com" })) as Record<string, unknown>;

    expect(result.text).toBe("ABCDEFGHIJ");
    expect(result.url).toBe("https://example.com");
    expect(result.finalUrl).toBe("https://example.com/canonical");
    expect(result.extractor).toBe("tavily");
    expect(result.tookMs).toBe(42);
  });

  it("falls back to result.content when rawContent is empty", async () => {
    runTavilyExtract.mockImplementationOnce(async () => ({
      provider: "tavily",
      results: [
        {
          url: "https://example.com",
          rawContent: "",
          content: "short snippet",
        },
      ],
    }));
    const tool = createTavilyWebFetchProvider().createTool({
      config: {} as OpenClawConfig,
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({ url: "https://example.com" })) as Record<string, unknown>;

    expect(result.text).toBe("short snippet");
  });

  it("scopes webFetch.apiKey overrides to the fetch provider only", () => {
    const cfg = {
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: { apiKey: "search-key", baseUrl: "https://search.example" },
              webFetch: { apiKey: "fetch-override", baseUrl: "https://fetch.example" },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveTavilyApiKey(cfg)).toBe("search-key");
    expect(resolveTavilyBaseUrl(cfg)).toBe("https://search.example");
    expect(resolveTavilyFetchApiKey(cfg)).toBe("fetch-override");
    expect(resolveTavilyFetchBaseUrl(cfg)).toBe("https://fetch.example");

    expect(TAVILY_WEB_FETCH_PROVIDER_SHARED.getConfiguredCredentialValue?.(cfg)).toBe(
      "fetch-override",
    );

    const target = {} as OpenClawConfig;
    TAVILY_WEB_FETCH_PROVIDER_SHARED.setConfiguredCredentialValue?.(target, "tvly-new");
    expect(
      (target.plugins?.entries?.tavily?.config as { webSearch?: { apiKey?: unknown } } | undefined)
        ?.webSearch?.apiKey,
    ).toBe("tvly-new");
  });

  it("falls back to webSearch credentials when no webFetch override is configured", () => {
    const cfg = {
      plugins: {
        entries: {
          tavily: {
            config: { webSearch: { apiKey: "search-key", baseUrl: "https://search.example" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveTavilyFetchApiKey(cfg)).toBe("search-key");
    expect(resolveTavilyFetchBaseUrl(cfg)).toBe("https://search.example");
  });

  it("honors legacy tools.web.fetch.tavily.apiKey credentials at execution time", async () => {
    const cfg = {
      plugins: {
        entries: {
          tavily: {
            config: { webSearch: { apiKey: "search-key", baseUrl: "https://search.example" } },
          },
        },
      },
    } as OpenClawConfig;
    const fetchConfig = {
      tavily: { apiKey: "legacy-fetch-key" },
    };
    const tool = createTavilyWebFetchProvider().createTool({ config: cfg, fetchConfig });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    expect(resolveTavilyFetchApiKey(undefined, "legacy-fetch-key")).toBe("legacy-fetch-key");

    await tool.execute({ url: "https://example.com" });
    expect(runTavilyExtract).toHaveBeenLastCalledWith({
      cfg,
      urls: ["https://example.com"],
      format: "markdown",
      extractDepth: "advanced",
      apiKey: "legacy-fetch-key",
      baseUrl: "https://search.example",
    });
  });

  it("forwards the fetch-scoped apiKey/baseUrl override into runTavilyExtract", async () => {
    const cfg = {
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: { apiKey: "search-key" },
              webFetch: { apiKey: "fetch-override", baseUrl: "https://fetch.example" },
            },
          },
        },
      },
    } as OpenClawConfig;
    const tool = createTavilyWebFetchProvider().createTool({ config: cfg });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ url: "https://example.com" });
    expect(runTavilyExtract).toHaveBeenLastCalledWith({
      cfg,
      urls: ["https://example.com"],
      format: "markdown",
      extractDepth: "advanced",
      apiKey: "fetch-override",
      baseUrl: "https://fetch.example",
    });
  });
});
