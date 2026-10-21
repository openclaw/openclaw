import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSearxngSearch } from "./searxng-client.js";

installPinnedHostnameTestHooks();
afterEach(() => vi.restoreAllMocks());

function search(params: Partial<Parameters<typeof runSearxngSearch>[0]> = {}) {
  return runSearxngSearch({
    baseUrl: "http://127.0.0.1:8888",
    query: "openclaw",
    cacheTtlMinutes: 0,
    ...params,
  });
}

describe("searxng client", () => {
  it("builds the request URL from plugin config", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
    const webSearch = {
      baseUrl: "http://127.0.0.1:8888/search/",
      categories: "general,news",
      language: "en",
    };
    await runSearxngSearch({
      query: "openclaw",
      cacheTtlMinutes: 0,
      config: { plugins: { entries: { searxng: { config: { webSearch } } } } },
    });

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:8888/search?q=openclaw&format=json&categories=general%2Cnews&language=en",
      expect.anything(),
    );
  });

  it("normalizes, filters, and caps provider result rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        results: [
          {
            title: "Kitten",
            url: "https://example.com/kitten",
            content: "A cute kitten",
            img_src: "https://cdn.example.com/kitten.jpg",
          },
          { title: { text: "bad" }, url: "https://example.com/bad-title" },
          { title: "bad URL", url: 3 },
          { title: "No snippet", url: "https://example.com/text", content: { text: "bad" } },
          { title: "Capped", url: "https://example.com/capped" },
        ],
      }),
    );

    const result = await search({ query: "kittens", count: 2 });

    expect(result.count).toBe(2);
    const rows = result.results as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.url)).toEqual([
      "https://example.com/kitten",
      "https://example.com/text",
    ]);
    expect(rows[0]?.title).toEqual(expect.stringContaining("Kitten"));
    expect(rows[0]?.snippet).toEqual(expect.stringContaining("A cute kitten"));
    expect(rows[0]?.img_src).toBe("https://cdn.example.com/kitten.jpg");
    expect(rows[0]?.siteName).toBe("example.com");
  });

  it("retries an empty category search with general results", async () => {
    const categories = "weather,news";
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(
        Response.json({
          results: [{ title: "Weather", url: "https://example.com/weather" }],
        }),
      );
    const result = await search({ categories });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8888/search?q=openclaw&format=json&categories=weather%2Cnews",
      expect.anything(),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8888/search?q=openclaw&format=json&categories=general",
      expect.anything(),
    );
    expect(result).toMatchObject({
      count: 1,
      results: [{ url: "https://example.com/weather" }],
    });
  });

  it("preserves the upstream HTTP error status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream rejected search", { status: 429 }),
    );
    await expect(search()).rejects.toMatchObject({
      status: 429,
      statusCode: 429,
    });
  });

  it("rejects invalid and incomplete response bodies", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{"));
    await expect(search({ query: "invalid" })).rejects.toThrow("SearXNG returned invalid JSON.");

    const chunk = new TextEncoder().encode("partial");
    let sentChunk = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentChunk) {
          sentChunk = true;
          controller.enqueue(chunk);
          return;
        }
        controller.error(new Error("stream reset"));
      },
    });
    fetch.mockResolvedValueOnce(new Response(stream));
    await expect(search({ query: "partial" })).rejects.toThrow(
      "SearXNG response incomplete after 7 bytes.",
    );
  });

  it("rejects private redirects from a public HTTPS endpoint", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.redirect("https://127.0.0.1/search"))
      .mockResolvedValueOnce(Response.json({ results: [] }));

    await expect(search({ baseUrl: "https://search.example.com/searxng" })).rejects.toMatchObject({
      name: "SsrFBlockedError",
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://search.example.com/searxng/search?q=openclaw&format=json",
      expect.anything(),
    );
  });

  it("allows private redirects from a configured internal HTTPS endpoint", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.redirect("https://127.0.0.1/search"))
      .mockResolvedValueOnce(
        Response.json({ results: [{ title: "Local result", url: "https://example.com/local" }] }),
      );

    await expect(search({ baseUrl: "https://search.internal/searxng" })).resolves.toMatchObject({
      results: [{ url: "https://example.com/local" }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://search.internal/searxng/search?q=openclaw&format=json",
      expect.anything(),
    );
    expect(fetch).toHaveBeenNthCalledWith(2, "https://127.0.0.1/search", expect.anything());
  });

  it("rejects cleartext public hosts", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
    await expect(search({ baseUrl: "http://search.example.com:8080" })).rejects.toThrow(
      "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
