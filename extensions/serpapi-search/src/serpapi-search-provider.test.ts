import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { callSerpApi } = vi.hoisted(() => ({
  callSerpApi: vi.fn(async (_opts: unknown) => ({ organic_results: [] as unknown[] })),
}));

vi.mock("./serpapi-client.js", () => ({
  callSerpApi,
}));

describe("serpapi web search provider", () => {
  let createSerpApiWebSearchProvider: typeof import("./serpapi-search-provider.js").createSerpApiWebSearchProvider;

  afterAll(() => {
    vi.doUnmock("./serpapi-client.js");
    vi.resetModules();
  });

  beforeAll(async () => {
    ({ createSerpApiWebSearchProvider } = await import("./serpapi-search-provider.js"));
    await import("../index.js");
  });

  beforeEach(() => {
    callSerpApi.mockReset();
    callSerpApi.mockResolvedValue({ organic_results: [] });
  });

  it("exposes serpapi metadata and enables the plugin in config", () => {
    const provider = createSerpApiWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("serpapi");
    expect(provider.label).toBe("SerpApi Search");
    expect(provider.credentialPath).toBe("plugins.entries.serpapi-search.config.webSearch.apiKey");

    const pluginEntry = applied.plugins?.entries?.["serpapi-search"];
    if (!pluginEntry) {
      throw new Error("expected serpapi-search plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("maps tool arguments to callSerpApi params", async () => {
    const provider = createSerpApiWebSearchProvider();
    const tool = provider.createTool({ config: { test: true } } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "openclaw docs", gl: "ua", count: 3 });

    expect(callSerpApi).toHaveBeenCalledOnce();
    const call = callSerpApi.mock.calls[0][0] as Record<string, unknown>;
    expect(call.engine).toBe("google_light");
    const params = call.params as Record<string, unknown>;
    expect(params.q).toBe("openclaw docs");
    expect(params.gl).toBe("ua");
    expect(call.allowedParams).toContain("q");
    expect(call.allowedParams).toContain("location");
    expect(call.allowedParams).toContain("zero_trace");
  });

  it("defaults gl to us when not provided", async () => {
    const provider = createSerpApiWebSearchProvider();
    const tool = provider.createTool({ config: {} } as never);

    await tool!.execute({ query: "hello" });

    const params = callSerpApi.mock.calls[0][0].params as Record<string, unknown>;
    expect(params.gl).toBe("us");
  });

  it("extracts and slices organic results by count", async () => {
    callSerpApi.mockResolvedValue({
      organic_results: Array.from({ length: 8 }, (_, i) => ({
        title: `Result ${i}`,
        link: `https://example.com/${i}`,
        snippet: `Snippet ${i}`,
      })),
      related_searches: [{ query: "related" }],
    });

    const provider = createSerpApiWebSearchProvider();
    const tool = provider.createTool({ config: {} } as never);
    const result = (await tool!.execute({ query: "test", count: 3 })) as Record<string, unknown>;

    expect(result.engine).toBe("google_light");
    const results = result.results as Record<string, unknown>[];
    expect(results).toHaveLength(3);
    expect(typeof results[0].title).toBe("string");
    expect(results[0].title as string).toContain("Result 0");
    expect(results[0].url).toBe("https://example.com/0");
    expect(typeof results[0].snippet).toBe("string");
    expect(results[0].snippet as string).toContain("Snippet 0");
    expect(result.related_searches).toEqual([{ query: "related" }]);
  });

  it("falls back to null when link or snippet is absent", async () => {
    callSerpApi.mockResolvedValue({
      organic_results: [{ title: "No link no snippet" }],
    });

    const provider = createSerpApiWebSearchProvider();
    const tool = provider.createTool({ config: {} } as never);
    const result = (await tool!.execute({ query: "test" })) as Record<string, unknown>;

    const first = (result.results as Record<string, unknown>[])[0];
    expect(first.url).toBeNull();
    expect(first.snippet).toBeNull();
  });

  it("passes optional params only when provided", async () => {
    const provider = createSerpApiWebSearchProvider();
    const tool = provider.createTool({ config: {} } as never);

    await tool!.execute({ query: "test", location: "Austin, Texas", start: 10 });

    const params = callSerpApi.mock.calls[0][0].params as Record<string, unknown>;
    expect(params.location).toBe("Austin, Texas");
    expect(params.start).toBe(10);
  });

  it("omits optional params when not provided", async () => {
    const provider = createSerpApiWebSearchProvider();
    const tool = provider.createTool({ config: {} } as never);

    await tool!.execute({ query: "test" });

    const params = callSerpApi.mock.calls[0][0].params as Record<string, unknown>;
    expect(params.location).toBeUndefined();
    expect(params.start).toBeUndefined();
    expect(params.google_domain).toBeUndefined();
  });
});
