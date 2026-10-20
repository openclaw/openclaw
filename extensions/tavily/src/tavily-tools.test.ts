import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
  return { plugins: { entries: { tavily: { config: { webSearch } } } } };
}

describe("tavily tools", () => {
  let createTavilyWebSearchProvider: typeof import("../web-search-contract-api.js").createTavilyWebSearchProvider;
  let captureTavilyTools: typeof import("./tavily-tools.test-support.js").captureTavilyTools;
  beforeAll(async () => {
    ({ createTavilyWebSearchProvider } = await import("../web-search-contract-api.js"));
    ({ captureTavilyTools } = await import("./tavily-tools.test-support.js"));
  });

  beforeEach(() => {
    runTavilySearch.mockReset().mockImplementation(async (params) => params);
    runTavilyExtract.mockReset().mockImplementation(async (params) => ({ ok: true, params }));
    vi.unstubAllEnvs();
  });

  function providerTool() {
    const tool = createTavilyWebSearchProvider().createTool({ config: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    return tool;
  }

  it("forwards cancellation through the public provider registration", async () => {
    const tool = providerTool();
    const controller = new AbortController();
    const context = { signal: controller.signal };
    await tool.execute({ query: "cancel" }, context);
    expect(runTavilySearch).toHaveBeenCalledWith(expect.objectContaining(context));
    const reason = new Error("cancelled");
    controller.abort(reason);
    runTavilySearch.mockClear();
    await expect(tool.execute({ query: "cancel" }, context)).rejects.toBe(reason);
    expect(runTavilySearch).not.toHaveBeenCalled();
  });

  it("normalizes generic Tavily search count before dispatch", async () => {
    const tool = providerTool();
    const result = await tool.execute({ query: "weather sf", count: "7" });
    expect(result).toEqual({ cfg: {}, query: "weather sf", maxResults: 7 });
    await expect(tool.execute({ query: "weather sf", count: "7.5" })).rejects.toThrow(
      "count must be an integer from 1 to 20",
    );
  });

  it.each(["search", "extract"] as const)("forwards standalone %s aborts", async (operation) => {
    const tool = captureTavilyTools()(`tavily_${operation}`);
    const args = operation === "search" ? { query: "cancel" } : { urls: ["https://example.com"] };
    const controller = new AbortController();
    await tool.execute("call-cancel", args, controller.signal);
    const networkOwner = operation === "search" ? runTavilySearch : runTavilyExtract;
    const context = { signal: controller.signal };
    expect(networkOwner).toHaveBeenCalledWith(expect.objectContaining(context));
    controller.abort(new Error(`${operation} preflight aborted`));
    const preflight = tool.execute("preflight", args, controller.signal);
    await expect(preflight).rejects.toBe(controller.signal.reason);
    expect(networkOwner).toHaveBeenCalledOnce();
  });

  it("late-binds tools to the resolved runtime config snapshot", async () => {
    const rawConfig = configWithWebSearch({
      apiKey: { source: "exec", provider: "default", id: "printf resolved-key" },
    });
    const runtimeConfig = configWithWebSearch({ apiKey: "resolved-key" });
    const tools = captureTavilyTools(rawConfig);
    const searchTool = tools("tavily_search", { config: rawConfig, runtimeConfig });
    const extractTool = tools("tavily_extract", {
      config: rawConfig,
      getRuntimeConfig: () => runtimeConfig,
    });
    expect(searchTool.resultContentSource).toBe("network");
    expect(extractTool.resultContentSource).toBe("network");
    await searchTool.execute("search-call", { query: "openclaw" });
    await extractTool.execute("extract-call", { urls: ["https://example.com"] });
    expect(runTavilySearch.mock.calls[0]?.[0]?.cfg).toBe(runtimeConfig);
    expect(runTavilySearch.mock.calls[0]?.[0]?.query).toBe("openclaw");
    expect(runTavilyExtract.mock.calls[0]?.[0]?.cfg).toBe(runtimeConfig);
    expect(runTavilyExtract.mock.calls[0]?.[0]?.urls).toEqual(["https://example.com"]);
  });

  it("rejects chunks_per_source without query", async () => {
    const tool = captureTavilyTools()("tavily_extract");
    const result = tool.execute("id", { urls: ["https://example.com"], chunks_per_source: 2 });
    await expect(result).rejects.toThrow(
      "tavily_extract requires query when chunks_per_source is set.",
    );
    expect(runTavilyExtract).not.toHaveBeenCalled();
  });

  it("rejects blank extract URLs before Tavily calls and trims valid URLs", async () => {
    const tool = captureTavilyTools()("tavily_extract");
    await expect(tool.execute("extract", { urls: ["   "] })).rejects.toThrow(
      "tavily_extract requires at least one URL.",
    );
    expect(runTavilyExtract).not.toHaveBeenCalled();
    await tool.execute("extract", { urls: [" https://example.com/article "] });
    expect(runTavilyExtract.mock.calls[0]?.[0]?.urls).toEqual(["https://example.com/article"]);
  });

  it("reads plugin web search config and prefers it over env defaults", () => {
    vi.stubEnv("TAVILY_API_KEY", "env-key");
    vi.stubEnv("TAVILY_BASE_URL", "https://env.tavily.test");
    const cfg = configWithWebSearch({
      apiKey: "plugin-key",
      baseUrl: "https://plugin.test",
    });
    expect(resolveTavilyApiKey(cfg)).toBe("plugin-key");
    expect(resolveTavilyBaseUrl(cfg)).toBe("https://plugin.test");
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
