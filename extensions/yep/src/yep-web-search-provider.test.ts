import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, createYepWebSearchProvider } from "./yep-web-search-provider.js";

describe("yep web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("normalizes ISO 639-1 language codes", () => {
    expect(__testing.normalizeYepLanguage("en")).toBe("en");
    expect(__testing.normalizeYepLanguage("DE")).toBe("de");
    expect(__testing.normalizeYepLanguage(" fr ")).toBe("fr");
    expect(__testing.normalizeYepLanguage("en-US")).toBeUndefined();
    expect(__testing.normalizeYepLanguage("")).toBeUndefined();
    expect(__testing.normalizeYepLanguage(undefined)).toBeUndefined();
  });

  it("returns missing key payload when no API key is available", async () => {
    vi.stubEnv("YEP_API_KEY", "");
    const provider = createYepWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "test" });
    expect(result).toMatchObject({ error: "missing_yep_api_key" });
  });

  it("returns validation errors for invalid date ranges", async () => {
    vi.stubEnv("YEP_API_KEY", "");
    const provider = createYepWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "yep_test",
        yep: { apiKey: "yep_test" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "test query",
      date_after: "2026-03-20",
      date_before: "2026-03-01",
    });

    expect(result).toMatchObject({ error: "invalid_date_range" });
  });

  it("sends correct request body to Yep API", async () => {
    vi.stubEnv("YEP_API_KEY", "yep_test_key");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
      return {
        ok: true,
        json: async () => ({
          success: true,
          results: [
            {
              url: "https://example.com/page",
              title: "Example Page",
              description: "A test description",
            },
          ],
        }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createYepWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "yep_test_key",
        yep: { apiKey: "yep_test_key" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({
      query: "test query",
      count: 3,
      language: "en",
      include_domains: "example.com",
    })) as Record<string, unknown>;

    expect(result.provider).toBe("yep");
    expect(result.query).toBe("test query");
    expect(result.count).toBe(1);
    expect(Array.isArray(result.results)).toBe(true);

    const fetchCall = mockFetch.mock.calls[0];
    const requestUrl = String(fetchCall?.[0]);
    expect(requestUrl).toBe(__testing.YEP_SEARCH_ENDPOINT);

    const requestInit = fetchCall?.[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).toMatchObject({
      Authorization: "Bearer yep_test_key",
      "Content-Type": "application/json",
    });

    const requestBody = JSON.parse(requestInit.body as string);
    expect(requestBody).toMatchObject({
      query: "test query",
      limit: 3,
      type: "basic",
      language: ["en"],
      include_domains: "example.com",
    });
  });

  it("maps results with description and snippet fallback", async () => {
    vi.stubEnv("YEP_API_KEY", "yep_test_key");
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          success: true,
          results: [
            { url: "https://a.com", title: "A", description: "desc A" },
            { url: "https://b.com", title: "B", snippet: "snippet B" },
            { url: "https://c.com", title: "C" },
          ],
        }),
      } as Response;
    });
    global.fetch = mockFetch as typeof global.fetch;

    const provider = createYepWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "yep_test_key",
        yep: { apiKey: "yep_test_key" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({ query: "test" })) as Record<string, unknown>;
    const results = result.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    // description field takes priority, snippet is fallback
    expect(results[0]?.description).toContain("desc A");
    expect(results[1]?.description).toContain("snippet B");
    expect(results[2]?.description).toBe("");
  });
});
