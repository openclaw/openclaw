import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { __testing, createExaWebSearchProvider } from "./exa-web-search-provider.js";

describe("exa web search provider", () => {
  it("registers the web search provider", () => {
    const registrations: { webSearchProviders: unknown[] } = { webSearchProviders: [] };

    const mockApi = {
      registerWebSearchProvider(provider: unknown) {
        registrations.webSearchProviders.push(provider);
      },
      config: {},
    };

    plugin.register(mockApi as never);

    expect(plugin.id).toBe("exa");
    expect(plugin.name).toBe("Exa Plugin");
    expect(registrations.webSearchProviders).toHaveLength(1);

    const provider = registrations.webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("exa");
    expect(provider.autoDetectOrder).toBe(65);
    expect(provider.envVars).toEqual(["EXA_API_KEY"]);
  });

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

  it("accepts current Exa contents object options from the docs", () => {
    expect(
      __testing.parseExaContents({
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      }),
    ).toEqual({
      value: {
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
      },
    });
  });

  it("rejects invalid Exa contents objects", () => {
    expect(
      __testing.parseExaContents({
        highlights: { numSentences: 0 },
      }),
    ).toMatchObject({
      error: "invalid_contents",
    });
  });

  it("exposes newer documented Exa search types and count limits", () => {
    const provider = createExaWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { exa: { apiKey: "exa-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const parameters = tool.parameters as {
      properties?: {
        count?: { maximum?: number };
        type?: { enum?: string[] };
      };
    };

    expect(parameters.properties?.count?.maximum).toBe(100);
    expect(parameters.properties?.type?.enum).toEqual([
      "auto",
      "neural",
      "fast",
      "deep",
      "deep-reasoning",
      "instant",
    ]);
    expect(__testing.resolveExaSearchCount(80, 10)).toBe(80);
    expect(__testing.resolveExaSearchCount(120, 10)).toBe(100);
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

  it("returns validation errors for invalid date input", async () => {
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
      date_after: "2026-02-31",
    });

    expect(result).toMatchObject({
      error: "invalid_date",
    });
  });

  describe("resolveExaSearchEndpoint", () => {
    const { resolveExaSearchEndpoint } = __testing;

    it("returns the default endpoint for undefined", () => {
      expect(resolveExaSearchEndpoint(undefined)).toBe("https://api.exa.ai/search");
    });

    it("returns the default endpoint for empty string", () => {
      expect(resolveExaSearchEndpoint("")).toBe("https://api.exa.ai/search");
    });

    it("appends /search to a bare origin", () => {
      expect(resolveExaSearchEndpoint("https://api.exa.ai")).toBe("https://api.exa.ai/search");
    });

    it("appends /search to a bare origin with trailing slash", () => {
      expect(resolveExaSearchEndpoint("https://api.exa.ai/")).toBe("https://api.exa.ai/search");
    });

    it("appends /search to a path-prefixed baseUrl", () => {
      expect(resolveExaSearchEndpoint("https://proxy.example.com/exa")).toBe(
        "https://proxy.example.com/exa/search",
      );
    });

    it("appends /search to a path-prefixed baseUrl with trailing slash", () => {
      expect(resolveExaSearchEndpoint("https://proxy.example.com/exa/")).toBe(
        "https://proxy.example.com/exa/search",
      );
    });

    it("does not double-append when path already ends with /search", () => {
      expect(resolveExaSearchEndpoint("https://api.exa.ai/search")).toBe(
        "https://api.exa.ai/search",
      );
    });

    it("does not double-append when path ends with /search/ (trailing slash)", () => {
      expect(resolveExaSearchEndpoint("https://api.exa.ai/search/")).toBe(
        "https://api.exa.ai/search",
      );
    });

    it("does not double-append for a versioned /v1/search path", () => {
      expect(resolveExaSearchEndpoint("https://api.exa.ai/v1/search")).toBe(
        "https://api.exa.ai/v1/search",
      );
    });

    it("correctly appends /search when hostname contains the word 'search'", () => {
      expect(resolveExaSearchEndpoint("https://search.example.com/exa")).toBe(
        "https://search.example.com/exa/search",
      );
    });

    it("preserves query string", () => {
      expect(resolveExaSearchEndpoint("https://api.exa.ai?version=2")).toBe(
        "https://api.exa.ai/search?version=2",
      );
    });

    it("preserves fragment", () => {
      expect(resolveExaSearchEndpoint("https://api.exa.ai#section")).toBe(
        "https://api.exa.ai/search#section",
      );
    });

    it("auto-prepends https:// for bare hostname", () => {
      expect(resolveExaSearchEndpoint("api.exa.ai")).toBe("https://api.exa.ai/search");
    });

    it("auto-prepends https:// for bare hostname with path", () => {
      expect(resolveExaSearchEndpoint("proxy.example.com/exa")).toBe(
        "https://proxy.example.com/exa/search",
      );
    });

    it("falls back to default endpoint for completely malformed input", () => {
      expect(resolveExaSearchEndpoint("://not-a-url")).toBe("https://api.exa.ai/search");
    });
  });
});
