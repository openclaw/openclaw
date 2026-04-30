import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTavilyApiKey, resolveTavilyFetchConfig } from "./config.js";

const { runTavilyExtract } = vi.hoisted(() => ({
  runTavilyExtract: vi.fn(async (params: unknown) => ({
    provider: "tavily",
    count: 1,
    results: [
      {
        url: (params as { urls?: unknown[] }).urls?.[0] ?? "",
        rawContent: "ABCDEFGHIJ",
        content: "ABCDEFGHIJ",
      },
    ],
    params,
  })),
}));

vi.mock("./tavily-client.js", () => ({
  runTavilyExtract,
}));

describe("tavily web-fetch provider", () => {
  let createTavilyWebFetchProvider: typeof import("./tavily-fetch-provider.js").createTavilyWebFetchProvider;
  let TAVILY_WEB_FETCH_PROVIDER_SHARED: typeof import("./tavily-fetch-provider-shared.js").TAVILY_WEB_FETCH_PROVIDER_SHARED;

  beforeAll(async () => {
    ({ createTavilyWebFetchProvider } = await import("./tavily-fetch-provider.js"));
    ({ TAVILY_WEB_FETCH_PROVIDER_SHARED } = await import("./tavily-fetch-provider-shared.js"));
  });

  beforeEach(() => {
    runTavilyExtract.mockClear();
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createTavilyWebFetchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("tavily");
    expect(provider.envVars).toEqual(["TAVILY_API_KEY"]);
    expect(provider.autoDetectOrder).toBe(70);
    expect(provider.credentialPath).toBe("plugins.entries.tavily.config.webSearch.apiKey");
    expect(provider.inactiveSecretPaths).toContain(
      "plugins.entries.tavily.config.webSearch.apiKey",
    );
    expect(provider.inactiveSecretPaths).toContain("plugins.entries.tavily.config.webFetch.apiKey");
    expect(provider.inactiveSecretPaths).toContain("tools.web.fetch.tavily.apiKey");
    expect(applied.plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("maps generic web_fetch args into Tavily extract params with default basic depth", async () => {
    const provider = createTavilyWebFetchProvider();
    const tool = provider.createTool({
      config: { test: true } as unknown as OpenClawConfig,
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ url: "https://example.com" });

    expect(runTavilyExtract).toHaveBeenCalledWith({
      cfg: { test: true },
      urls: ["https://example.com"],
      extractDepth: "basic",
    });
  });

  it("translates extractMode 'advanced' into extract_depth 'advanced'", async () => {
    const provider = createTavilyWebFetchProvider();
    const tool = provider.createTool({
      config: {} as OpenClawConfig,
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ url: "https://example.com", extractMode: "advanced" });

    expect(runTavilyExtract).toHaveBeenCalledWith({
      cfg: {},
      urls: ["https://example.com"],
      extractDepth: "advanced",
    });
  });

  it("post-truncates rawContent and content when maxChars is supplied", async () => {
    const provider = createTavilyWebFetchProvider();
    const tool = provider.createTool({
      config: {} as OpenClawConfig,
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({
      url: "https://example.com",
      maxChars: 4,
    })) as { results: Array<{ rawContent?: string; content?: string }> };

    expect(typeof result.results[0]?.rawContent).toBe("string");
    expect((result.results[0]?.rawContent ?? "").length).toBeLessThanOrEqual(4);
    expect((result.results[0]?.content ?? "").length).toBeLessThanOrEqual(4);
  });

  it("ignores unsupported firecrawl-shaped knobs (proxy, storeInCache)", async () => {
    const provider = createTavilyWebFetchProvider();
    const tool = provider.createTool({
      config: {} as OpenClawConfig,
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({
      url: "https://example.com",
      proxy: "stealth",
      storeInCache: false,
    });

    expect(runTavilyExtract).toHaveBeenCalledWith({
      cfg: {},
      urls: ["https://example.com"],
      extractDepth: "basic",
    });
  });

  it("getConfiguredCredentialValue prefers webFetch.apiKey over webSearch.apiKey", () => {
    expect(
      TAVILY_WEB_FETCH_PROVIDER_SHARED.getConfiguredCredentialValue?.({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: { apiKey: "search-key" },
                webFetch: { apiKey: "fetch-override" },
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toBe("fetch-override");

    expect(
      TAVILY_WEB_FETCH_PROVIDER_SHARED.getConfiguredCredentialValue?.({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: { apiKey: "search-only" },
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toBe("search-only");
  });

  it("setConfiguredCredentialValue writes to the canonical webSearch.apiKey", () => {
    const target = {} as OpenClawConfig;
    TAVILY_WEB_FETCH_PROVIDER_SHARED.setConfiguredCredentialValue?.(target, "tvly-new");
    expect(
      (target.plugins?.entries?.tavily?.config as { webSearch?: { apiKey?: unknown } } | undefined)
        ?.webSearch?.apiKey,
    ).toBe("tvly-new");
  });

  it("resolves webFetch.apiKey override ahead of webSearch.apiKey via resolveTavilyApiKey", () => {
    const cfg = {
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: { apiKey: "search-key" },
              webFetch: { apiKey: "fetch-override" },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveTavilyFetchConfig(cfg)).toEqual({ apiKey: "fetch-override" });
    expect(resolveTavilyApiKey(cfg)).toBe("fetch-override");
  });
});
