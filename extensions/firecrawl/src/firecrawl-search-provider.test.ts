import { describe, expect, it, vi } from "vitest";

const runFirecrawlSearch = vi.fn(async (params: Record<string, unknown>) => params);

vi.mock("./firecrawl-client.js", () => ({
  runFirecrawlSearch,
}));

describe("firecrawl web search provider", () => {
  it("exposes selection metadata and enables the plugin in config", async () => {
    const { createFirecrawlWebSearchProvider } = await import("./firecrawl-search-provider.js");

    const provider = createFirecrawlWebSearchProvider();
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("firecrawl");
    expect(provider.credentialPath).toBe("plugins.entries.firecrawl.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.firecrawl?.enabled).toBe(true);
  });

  it("maps generic arguments into firecrawl search params", async () => {
    const { createFirecrawlWebSearchProvider } = await import("./firecrawl-search-provider.js");
    const provider = createFirecrawlWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);

    const result = await tool.execute({
      query: "openclaw docs",
      count: 4,
    });

    expect(runFirecrawlSearch).toHaveBeenCalledWith({
      cfg: { test: true },
      query: "openclaw docs",
      count: 4,
    });
    expect(result).toEqual({
      cfg: { test: true },
      query: "openclaw docs",
      count: 4,
    });
  });
});
