import { describe, expect, it } from "vitest";
import { __testing, createExaWebSearchProvider } from "./exa-web-search-provider.js";

describe("exa web search provider", () => {
  it("exposes the expected metadata and selection wiring", () => {
    const provider = createExaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("exa");
    expect(provider.credentialPath).toBe("plugins.entries.exa.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.exa?.enabled).toBe(true);
  });

  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(__testing.resolveExaApiKey({ apiKey: "exa-secret" })).toBe("exa-secret");
  });

  it("normalizes Exa result descriptions from highlights before text", () => {
    expect(
      __testing.resolveExaDescription({
        highlights: ["first", "", "second"],
        text: "full text",
      }),
    ).toBe("first\nsecond");
    expect(__testing.resolveExaDescription({ text: "full text" })).toBe("full text");
  });

  it("handles month freshness without date overflow", () => {
    const iso = __testing.resolveFreshnessStartDate("month");
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });

  it("returns validation errors for conflicting time filters", async () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      freshness: "day",
      date_after: "2026-03-01",
    });

    expect(result).toMatchObject({
      error: "conflicting_time_filters",
    });
  });
});
