import { beforeEach, describe, expect, it, vi } from "vitest";

const { runFirecrawlSearch } = vi.hoisted(() => ({
  runFirecrawlSearch: vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    params,
  })),
}));

vi.mock("./firecrawl-client.js", () => ({
  runFirecrawlSearch,
}));

describe("firecrawl search tool", () => {
  beforeEach(() => {
    vi.resetModules();
    runFirecrawlSearch.mockReset();
    runFirecrawlSearch.mockImplementation(async (params: Record<string, unknown>) => ({
      ok: true,
      params,
    }));
  });

  it("normalizes optional search parameters before invoking Firecrawl", async () => {
    const { createFirecrawlSearchTool } = await import("./firecrawl-search-tool.js");
    const tool = createFirecrawlSearchTool({
      config: { env: "test" },
    } as never);

    const result = await tool.execute("call-1", {
      query: "web search",
      count: 6,
      timeoutSeconds: 12,
      sources: ["web", "", "news"],
      categories: ["research", ""],
      scrapeResults: true,
    });

    expect(runFirecrawlSearch).toHaveBeenCalledWith({
      cfg: { env: "test" },
      query: "web search",
      count: 6,
      timeoutSeconds: 12,
      sources: ["web", "news"],
      categories: ["research"],
      scrapeResults: true,
    });
    expect(result).toMatchObject({
      details: {
        ok: true,
        params: {
          cfg: { env: "test" },
          query: "web search",
          count: 6,
          timeoutSeconds: 12,
          sources: ["web", "news"],
          categories: ["research"],
          scrapeResults: true,
        },
      },
    });
  });
});
