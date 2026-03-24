import { beforeEach, describe, expect, it, vi } from "vitest";

const { runTavilySearch } = vi.hoisted(() => ({
  runTavilySearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./tavily-client.js", () => ({
  runTavilySearch,
}));

describe("tavily web search provider", () => {
  beforeEach(() => {
    vi.resetModules();
    runTavilySearch.mockReset();
    runTavilySearch.mockImplementation(async (params: Record<string, unknown>) => params);
  });

  it("exposes the expected metadata and selection wiring", async () => {
    const { createTavilyWebSearchProvider } = await import("./tavily-search-provider.js");

    const provider = createTavilyWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("tavily");
    expect(provider.credentialPath).toBe("plugins.entries.tavily.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("maps generic tool arguments into Tavily search params", async () => {
    const { createTavilyWebSearchProvider } = await import("./tavily-search-provider.js");
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
});
