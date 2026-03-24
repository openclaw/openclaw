import { describe, expect, it, vi } from "vitest";

const runDuckDuckGoSearch = vi.fn(async (params: Record<string, unknown>) => params);

vi.mock("./ddg-client.js", () => ({
  runDuckDuckGoSearch,
}));

describe("duckduckgo web search provider", () => {
  it("exposes keyless metadata and enables the plugin in config", async () => {
    const { createDuckDuckGoWebSearchProvider } = await import("./ddg-search-provider.js");

    const provider = createDuckDuckGoWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("duckduckgo");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.duckduckgo?.enabled).toBe(true);
  });

  it("maps generic tool arguments into DuckDuckGo search params", async () => {
    const { createDuckDuckGoWebSearchProvider } = await import("./ddg-search-provider.js");
    const provider = createDuckDuckGoWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });

    expect(runDuckDuckGoSearch).toHaveBeenCalledWith({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });
    expect(result).toEqual({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });
  });
});
