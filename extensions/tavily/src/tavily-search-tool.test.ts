import { beforeEach, describe, expect, it, vi } from "vitest";

const { runTavilySearch } = vi.hoisted(() => ({
  runTavilySearch: vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    params,
  })),
}));

vi.mock("./tavily-client.js", () => ({
  runTavilySearch,
}));

describe("tavily search tool", () => {
  beforeEach(() => {
    vi.resetModules();
    runTavilySearch.mockReset();
    runTavilySearch.mockImplementation(async (params: Record<string, unknown>) => ({
      ok: true,
      params,
    }));
  });

  it("normalizes optional parameters before invoking Tavily", async () => {
    const { createTavilySearchTool } = await import("./tavily-search-tool.js");
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

  it("requires a query and drops empty domain arrays", async () => {
    const { createTavilySearchTool } = await import("./tavily-search-tool.js");
    const tool = createTavilySearchTool({
      config: { env: "test" },
    } as never);

    await expect(
      tool.execute("call-2", {
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
  });
});
