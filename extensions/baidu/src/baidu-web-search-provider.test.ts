import { describe, expect, it } from "vitest";
import { withEnv } from "../../../test/helpers/extensions/env.js";
import plugin from "../index.js";
import { __testing, createBaiduWebSearchProvider } from "./baidu-web-search-provider.js";

describe("baidu web search provider", () => {
  it("registers the Baidu web search provider", () => {
    const registrations: { webSearchProviders: unknown[] } = { webSearchProviders: [] };

    plugin.register({
      registerWebSearchProvider(provider: unknown) {
        registrations.webSearchProviders.push(provider);
      },
    } as never);

    expect(plugin.id).toBe("baidu");
    expect(plugin.name).toBe("Baidu Plugin");
    expect(registrations.webSearchProviders).toHaveLength(1);

    const provider = registrations.webSearchProviders[0] as Record<string, unknown>;
    expect(provider.id).toBe("baidu");
    expect(provider.autoDetectOrder).toBe(15);
    expect(provider.envVars).toEqual(["APPBUILDER_API_KEY", "APPBUILDER_TOKEN"]);
  });

  it("exposes plugin-owned credential metadata and enables the plugin in config", () => {
    const provider = createBaiduWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("baidu");
    expect(provider.credentialPath).toBe("plugins.entries.baidu.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.baidu?.enabled).toBe(true);
  });

  it("prefers configured api keys over environment fallbacks", () => {
    expect(__testing.resolveBaiduApiKey({ apiKey: "appbuilder-config-key" })).toBe(
      "appbuilder-config-key",
    );
  });

  it("falls back to APPBUILDER_API_KEY and APPBUILDER_TOKEN", () => {
    withEnv({ APPBUILDER_API_KEY: "appbuilder-env-key" }, () => {
      expect(__testing.resolveBaiduApiKey({})).toBe("appbuilder-env-key");
    });

    withEnv({ APPBUILDER_TOKEN: "legacy-appbuilder-token" }, () => {
      expect(__testing.resolveBaiduApiKey({})).toBe("legacy-appbuilder-token");
    });
  });

  it("uses sane default base url, model, and deep search settings", () => {
    expect(__testing.resolveBaiduBaseUrl()).toBe("https://qianfan.baidubce.com/v2/ai_search");
    expect(__testing.resolveBaiduModel()).toBe("ernie-4.5-turbo-32k");
    expect(__testing.resolveBaiduEnableDeepSearch()).toBe(false);
    expect(__testing.resolveBaiduEnableDeepSearch({ enableDeepSearch: true })).toBe(true);
  });

  it("maps generic freshness values to Baidu recency filters", () => {
    expect(__testing.resolveBaiduRecency("pw")).toBe("week");
    expect(__testing.resolveBaiduRecency("pm")).toBe("month");
    expect(__testing.resolveBaiduRecency("semiyear")).toBe("semiyear");
    expect(__testing.resolveBaiduRecency("day")).toBeUndefined();
    expect(__testing.resolveBaiduRecency("invalid")).toBeUndefined();
  });

  it("builds RFC3339 page time ranges with an exclusive end bound", () => {
    expect(__testing.buildBaiduPageTimeRange("2026-03-01", "2026-03-02")).toEqual({
      gte: "2026-03-01T00:00:00Z",
      lt: "2026-03-03T00:00:00Z",
    });
    expect(__testing.buildBaiduPageTimeRange(undefined, undefined)).toBeNull();
  });

  it("deduplicates citations by url and preserves site metadata", () => {
    const citations = __testing.dedupeBaiduCitations([
      {
        url: "https://example.com/a",
        title: "Example A",
        website: "example.com",
        content: "summary a",
        date: "2026-03-28",
      },
      {
        url: "https://example.com/a",
        title: "Duplicate A",
      },
      {
        url: "https://example.com/b",
        title: "Example B",
      },
    ]);

    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({
      url: "https://example.com/a",
      siteName: "example.com",
      published: "2026-03-28",
    });
    expect(citations[1]).toMatchObject({
      url: "https://example.com/b",
      siteName: "example.com",
      published: undefined,
    });
    expect(citations[0].title).toContain("Example A");
    expect(citations[0].description).toContain("summary a");
    expect(citations[1].title).toContain("Example B");
    expect(citations[1].description).toBeUndefined();
  });

  it("returns missing-key errors before attempting a network call", async () => {
    const provider = createBaiduWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ query: "latest AI news" })).resolves.toMatchObject({
      error: "missing_baidu_api_key",
    });
  });

  it("rejects unsupported country and language filters", async () => {
    const provider = createBaiduWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { baidu: { apiKey: "appbuilder-test-key" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ query: "OpenClaw", country: "CN" })).resolves.toMatchObject({
      error: "unsupported_country",
    });
    await expect(tool.execute({ query: "OpenClaw", language: "zh" })).resolves.toMatchObject({
      error: "unsupported_language",
    });
  });

  it("validates freshness and conflicting time filters", async () => {
    const provider = createBaiduWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { baidu: { apiKey: "appbuilder-test-key" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(
      tool.execute({ query: "OpenClaw", freshness: "yesterday" }),
    ).resolves.toMatchObject({
      error: "invalid_freshness",
    });
    await expect(
      tool.execute({
        query: "OpenClaw",
        freshness: "week",
        date_after: "2026-03-01",
      }),
    ).resolves.toMatchObject({
      error: "conflicting_time_filters",
    });
  });

  it("validates ISO date inputs", async () => {
    const provider = createBaiduWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { baidu: { apiKey: "appbuilder-test-key" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(
      tool.execute({ query: "OpenClaw", date_after: "2026-02-31" }),
    ).resolves.toMatchObject({
      error: "invalid_date",
    });
    await expect(
      tool.execute({
        query: "OpenClaw",
        date_after: "2026-03-10",
        date_before: "2026-03-01",
      }),
    ).resolves.toMatchObject({
      error: "invalid_date_range",
    });
  });
});
