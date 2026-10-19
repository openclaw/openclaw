import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTavilyWebSearchProvider } from "./tavily-search-provider.js";

const { runTavilySearch } = vi.hoisted(() => ({
  runTavilySearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./tavily-client.js", () => ({
  runTavilySearch,
}));

describe("tavily web search provider", () => {
  beforeEach(() => {
    runTavilySearch.mockClear();
  });

  it("falls back to tools.web.search maxResults and timeoutSeconds", async () => {
    const tool = createTavilyWebSearchProvider().createTool({
      config: {},
      searchConfig: { maxResults: 8, timeoutSeconds: 45 },
    });
    if (!tool) {
      throw new Error("Expected Tavily search tool");
    }

    await tool.execute({ query: "openclaw docs" });
    await tool.execute({ query: "openclaw docs", count: 3 });

    expect(runTavilySearch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ maxResults: 8, timeoutSeconds: 45 }),
    );
    expect(runTavilySearch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ maxResults: 3, timeoutSeconds: 45 }),
    );
  });
});
