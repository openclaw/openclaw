import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTavilyApiKey,
  resolveTavilyBaseUrl,
  resolveTavilyExtractTimeoutSeconds,
  resolveTavilySearchTimeoutSeconds,
} from "./config.js";

const { runTavilySearch, runTavilyExtract } = vi.hoisted(() => ({
  runTavilySearch: vi.fn(async (params: Record<string, unknown>) => params),
  runTavilyExtract: vi.fn(async (params: Record<string, unknown>) => ({ ok: true, params })),
}));

vi.mock("./tavily-client.js", () => ({
  runTavilySearch,
  runTavilyExtract,
}));

function configWithWebSearch(webSearch: Record<string, unknown>): OpenClawConfig {
  return {
    plugins: { entries: { tavily: { config: { webSearch } } } },
  };
}

function fakeApi() {
  return createTestPluginApi({ config: {} });
}

describe("tavily tools", () => {
  let createTavilyWebSearchProvider: typeof import("../web-search-contract-api.js").createTavilyWebSearchProvider;
  let createTavilySearchTool: typeof import("./tavily-search-tool.js").createTavilySearchTool;
  let createTavilyExtractTool: typeof import("./tavily-extract-tool.js").createTavilyExtractTool;
  let tavilyPlugin: typeof import("../index.js").default;

  beforeAll(async () => {
    ({ createTavilyWebSearchProvider } = await import("../web-search-contract-api.js"));
    ({ createTavilySearchTool } = await import("./tavily-search-tool.js"));
    ({ createTavilyExtractTool } = await import("./tavily-extract-tool.js"));
    ({ default: tavilyPlugin } = await import("../index.js"));
  });

  beforeEach(() => {
    runTavilySearch.mockReset();
    runTavilySearch.mockImplementation(async (params: Record<string, unknown>) => params);
    runTavilyExtract.mockReset();
    runTavilyExtract.mockImplementation(async (params: Record<string, unknown>) => ({
      ok: true,
      params,
    }));
    vi.unstubAllEnvs();
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createTavilyWebSearchProvider();
    expect(provider.id).toBe("tavily");
    expect(provider.credentialPath).toBe("plugins.entries.tavily.config.webSearch.apiKey");
    expect(provider.applySelectionConfig?.({}).plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("forwards cancellation through the public provider registration", async () => {
    const tool = createTavilyWebSearchProvider().createTool({ config: {} });
    expect(tool).not.toBeNull();
    const controller = new AbortController();

    await tool!.execute({ query: "cancel" }, { signal: controller.signal });

    expect(runTavilySearch).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );

    const reason = new Error("cancelled");
    controller.abort(reason);
    runTavilySearch.mockClear();
    await expect(tool!.execute({ query: "cancel" }, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(runTavilySearch).not.toHaveBeenCalled();
  });

  it("normalizes generic Tavily search count before dispatch", async () => {
    const tool = createTavilyWebSearchProvider().createTool({ config: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "weather sf", count: "7" });

    expect(runTavilySearch).toHaveBeenCalledWith({
      cfg: {},
      query: "weather sf",
      maxResults: 7,
    });
    expect(result).toEqual({ cfg: {}, query: "weather sf", maxResults: 7 });
    await expect(tool.execute({ query: "weather sf", count: "7.5" })).rejects.toThrow(
      "count must be an integer from 1 to 20",
    );
  });

  it("normalizes optional parameters before invoking Tavily", async () => {
    const tool = createTavilySearchTool(fakeApi());

    await tool.execute("call-1", {
      query: "best docs",
      search_depth: "advanced",
      topic: "news",
      max_results: 5,
      include_answer: true,
      time_range: "week",
      include_domains: [" docs.openclaw.ai ", "   ", "openclaw.ai"],
      exclude_domains: [" bad.example ", ""],
    });

    expect(runTavilySearch).toHaveBeenCalledWith({
      cfg: {},
      query: "best docs",
      searchDepth: "advanced",
      topic: "news",
      maxResults: 5,
      includeAnswer: true,
      timeRange: "week",
      includeDomains: ["docs.openclaw.ai", "openclaw.ai"],
      excludeDomains: ["bad.example"],
    });
  });

  it.each(["search", "extract"] as const)(
    "forwards exact standalone Tavily %s cancellation into its network owner",
    async (operation) => {
      const tool =
        operation === "search"
          ? createTavilySearchTool(fakeApi())
          : createTavilyExtractTool(fakeApi());
      const args =
        operation === "search"
          ? { query: "standalone cancellation" }
          : { urls: ["https://example.com"] };
      const controller = new AbortController();

      await tool.execute("call-cancel", args, controller.signal);

      const networkOwner = operation === "search" ? runTavilySearch : runTavilyExtract;
      expect(networkOwner).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );

      controller.abort(new Error(`${operation} preflight aborted`));
      await expect(tool.execute("call-preflight", args, controller.signal)).rejects.toBe(
        controller.signal.reason,
      );
      expect(networkOwner).toHaveBeenCalledOnce();
    },
  );

  it("late-binds dedicated tools to the resolved runtime config snapshot", async () => {
    const rawConfig = configWithWebSearch({
      apiKey: { source: "exec", provider: "default", id: "printf resolved-key" },
    });
    const runtimeConfig = configWithWebSearch({ apiKey: "resolved-key" });
    const registeredTools = new Map<string, Parameters<OpenClawPluginApi["registerTool"]>[0]>();
    const api = createTestPluginApi({
      config: rawConfig,
      registerTool(tool, opts) {
        if (opts?.name) {
          registeredTools.set(opts.name, tool);
        }
      },
    });

    tavilyPlugin.register(api);
    const searchFactory = registeredTools.get("tavily_search");
    const extractFactory = registeredTools.get("tavily_extract");
    if (typeof searchFactory !== "function" || typeof extractFactory !== "function") {
      throw new Error("Expected Tavily tools to register as runtime-context factories");
    }

    const searchTool = searchFactory({
      config: rawConfig,
      runtimeConfig,
    });
    const extractTool = extractFactory({
      config: rawConfig,
      getRuntimeConfig: () => runtimeConfig,
    });
    if (Array.isArray(searchTool) || !searchTool || Array.isArray(extractTool) || !extractTool) {
      throw new Error("Expected single Tavily tool definitions");
    }
    expect(searchTool.resultContentSource).toBe("network");
    expect(extractTool.resultContentSource).toBe("network");

    await searchTool.execute("search-call", { query: "openclaw" });
    await extractTool.execute("extract-call", { urls: ["https://example.com"] });

    expect(runTavilySearch.mock.calls[0]?.[0]?.cfg).toBe(runtimeConfig);
    expect(runTavilySearch.mock.calls[0]?.[0]?.query).toBe("openclaw");
    expect(runTavilyExtract.mock.calls[0]?.[0]?.cfg).toBe(runtimeConfig);
    expect(runTavilyExtract.mock.calls[0]?.[0]?.urls).toEqual(["https://example.com"]);
  });

  it("drops empty domain arrays and forwards query-scoped chunking", async () => {
    const searchTool = createTavilySearchTool(fakeApi());
    await searchTool.execute("call-2", {
      query: "simple",
      include_domains: ["   "],
      exclude_domains: [],
    });
    expect(runTavilySearch).toHaveBeenCalledWith({
      cfg: {},
      query: "simple",
      includeAnswer: false,
    });

    const extractTool = createTavilyExtractTool(fakeApi());
    await extractTool.execute("id", {
      urls: ["https://example.com"],
      query: "pricing",
      chunks_per_source: 2,
    });

    expect(runTavilyExtract).toHaveBeenCalledWith({
      cfg: {},
      urls: ["https://example.com"],
      query: "pricing",
      chunksPerSource: 2,
      includeImages: false,
    });
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

  it("rejects blank extract URLs before Tavily calls and trims valid URLs", async () => {
    const tool = createTavilyExtractTool(fakeApi());

    await expect(
      tool.execute("extract-call", {
        urls: ["   "],
      }),
    ).rejects.toThrow("tavily_extract requires at least one URL.");

    expect(runTavilyExtract).not.toHaveBeenCalled();

    await tool.execute("extract-call", {
      urls: [" https://example.com/article "],
    });

    expect(runTavilyExtract.mock.calls[0]?.[0]?.urls).toEqual(["https://example.com/article"]);
  });

  it("rejects fractional and out-of-range integer options before Tavily calls", async () => {
    const searchTool = createTavilySearchTool(fakeApi());
    await expect(
      searchTool.execute("search-call", {
        query: "openclaw",
        max_results: 5.5,
      }),
    ).rejects.toThrow("max_results must be an integer from 1 to 20.");
    await expect(
      searchTool.execute("search-call", {
        query: "openclaw",
        max_results: 21,
      }),
    ).rejects.toThrow("max_results must be an integer from 1 to 20.");

    const extractTool = createTavilyExtractTool(fakeApi());
    await expect(
      extractTool.execute("extract-call", {
        urls: ["https://example.com"],
        query: "pricing",
        chunks_per_source: 2.5,
      }),
    ).rejects.toThrow("chunks_per_source must be an integer from 1 to 5.");
    await expect(
      extractTool.execute("extract-call", {
        urls: ["https://example.com"],
        query: "pricing",
        chunks_per_source: 6,
      }),
    ).rejects.toThrow("chunks_per_source must be an integer from 1 to 5.");

    expect(runTavilySearch).not.toHaveBeenCalled();
    expect(runTavilyExtract).not.toHaveBeenCalled();
  });

  it("reads plugin web search config and prefers it over env defaults", () => {
    vi.stubEnv("TAVILY_API_KEY", "env-key");
    vi.stubEnv("TAVILY_BASE_URL", "https://env.tavily.test");

    const cfg = configWithWebSearch({
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
    expect(resolveTavilySearchTimeoutSeconds()).toBe(30);
    expect(resolveTavilyExtractTimeoutSeconds()).toBe(60);
  });
});
