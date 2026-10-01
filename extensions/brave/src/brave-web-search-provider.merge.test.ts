import { describe, expect, it, vi } from "vitest";

describe("brave web search config merge", () => {
  it("keeps plugin webSearch runtime-only after merging it for the tool", async () => {
    vi.resetModules();
    const executeBraveSearch = vi.fn(
      async (_args: unknown, _searchConfig?: Record<string, unknown>) => ({ results: [] }),
    );
    vi.doMock("./brave-web-search-provider.runtime.js", () => ({ executeBraveSearch }));

    try {
      const { createBraveWebSearchProvider } = await import("./brave-web-search-provider.js");
      const webSearch = { apiKey: "brave-test-key", mode: "llm-context" };
      const tool = createBraveWebSearchProvider().createTool({
        config: { plugins: { entries: { brave: { config: { webSearch } } } } },
        searchConfig: { provider: "brave" },
      });

      await tool?.execute({ query: "OpenClaw docs" });

      const searchConfig = executeBraveSearch.mock.calls[0]?.[1];
      expect(searchConfig?.brave).toEqual({
        apiKey: "brave-test-key",
        mode: "llm-context",
      });
      expect(searchConfig?.apiKey).toBe("brave-test-key");
      expect(Object.keys(searchConfig ?? {})).toEqual(["provider", "apiKey"]);
      expect(Object.getOwnPropertyDescriptor(searchConfig ?? {}, "brave")?.enumerable).toBe(false);
    } finally {
      vi.doUnmock("./brave-web-search-provider.runtime.js");
      vi.resetModules();
    }
  });
});
