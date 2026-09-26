import { afterEach, describe, expect, it, vi } from "vitest";
import { createDuckDuckGoWebSearchProvider } from "./ddg-search-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DuckDuckGo provider result limits", () => {
  it.each([1, 2, 10])(
    "returns the first %s valid results with their own snippets",
    async (count) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          `
          <a class="result__a" href="https://example.com/empty-title"></a>
          <a class="result__snippet">Discarded empty-title snippet</a>
          <a class="result__a" href="">Missing URL</a>
          <a class="result__a" href="https://example.com/first">First</a>
          <a class="result__snippet">First snippet</a>
          <a class="result__a" href="">Another missing URL</a>
          <a class="result__snippet">Discarded missing-URL snippet</a>
          <a class="result__a" href="https://example.com/second">Second</a>
          <a class="result__a" href="https://example.com/third">Third</a>
          <a class="result__snippet">Third snippet</a>
        `,
          { headers: { "content-type": "text/html" } },
        ),
      );
      const searchConfig = { cacheTtlMinutes: 0 };
      const tool = createDuckDuckGoWebSearchProvider().createTool({
        config: { tools: { web: { search: searchConfig } } },
        searchConfig,
      });
      if (!tool) {
        throw new Error("Expected DuckDuckGo search tool");
      }

      const result = await tool.execute({ query: "DuckDuckGo valid result count", count });

      const expected = [
        { url: "https://example.com/first", snippet: expect.stringContaining("First snippet") },
        { url: "https://example.com/second", snippet: "" },
        { url: "https://example.com/third", snippet: expect.stringContaining("Third snippet") },
      ].slice(0, count);
      expect(result).toMatchObject({ count: expected.length, results: expected });
      expect(JSON.stringify(result)).not.toContain("Discarded");
    },
  );
});
