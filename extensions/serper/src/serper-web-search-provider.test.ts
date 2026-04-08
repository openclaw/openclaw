import { afterEach, describe, expect, it, vi } from "vitest";
import { createSerperWebSearchProvider } from "./serper-web-search-provider.js";

describe("serper web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("returns missing key error when no API key is configured", async () => {
    vi.stubEnv("SERPER_API_KEY", "");
    const provider = createSerperWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {},
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "test query" });
    expect(result).toEqual(
      expect.objectContaining({
        error: "missing_serper_api_key",
      }),
    );
  });

  it("sends correct request to Serper API with country and language", async () => {
    vi.stubEnv("SERPER_API_KEY", "test-key-123");

    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          organic: [
            {
              title: "Example Result",
              link: "https://example.com",
              snippet: "A test snippet",
              date: "2 days ago",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = createSerperWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { serper: { apiKey: "test-key-123" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "typescript generics",
      count: 3,
      country: "US",
      language: "en",
    });

    expect(capturedUrl).toBe("https://google.serper.dev/search");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-API-KEY"]).toBe("test-key-123");

    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      q: "typescript generics",
      num: 3,
      gl: "us",
      hl: "en",
    });

    expect(result.provider).toBe("serper");
    expect(result.query).toBe("typescript generics");
    expect(Array.isArray(result.results)).toBe(true);
    const results = result.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com");
  });

  it("handles empty organic results gracefully", async () => {
    vi.stubEnv("SERPER_API_KEY", "test-key");

    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ organic: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const provider = createSerperWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { serper: { apiKey: "test-key" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "obscure query" });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });
});
