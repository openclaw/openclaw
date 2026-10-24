import { afterEach, describe, expect, it, vi } from "vitest";
import { createTavilyWebSearchProvider } from "./tavily-search-provider.js";
import { captureTavilyTools } from "./tavily-tools.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["web_search", "tavily_search", "tavily_extract"] as const)(
  "%s shares cached content only with the same resolved credential",
  async (kind) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const content =
        new Headers(init?.headers).get("Authorization") === "Bearer fixture-tavily-a"
          ? "Account A content"
          : "Account B content";
      return Response.json({
        results: [
          { url: "https://example.com/shared", title: content, content, raw_content: content },
        ],
      });
    });
    const run = async (apiKey: string) => {
      const config = {
        plugins: { entries: { tavily: { config: { webSearch: { apiKey } } } } },
      };
      const args =
        kind === "tavily_extract"
          ? { urls: ["https://example.com/shared"] }
          : { query: `Tavily ${kind} credential cache isolation` };
      if (kind !== "web_search") {
        return (await captureTavilyTools(config)(kind).execute("credential-cache", args)).details;
      }
      const tool = createTavilyWebSearchProvider().createTool({ config, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected Tavily search tool");
      }
      return await tool.execute(args);
    };
    const first = await run("fixture-tavily-a");
    const other = await run("fixture-tavily-b");
    const repeated = await run("fixture-tavily-a");
    const contentField = kind === "tavily_extract" ? "rawContent" : "snippet";

    expect(first).toMatchObject({
      results: [{ [contentField]: expect.stringContaining("Account A content") }],
    });
    expect(other).toMatchObject({
      results: [{ [contentField]: expect.stringContaining("Account B content") }],
    });
    expect(repeated).toMatchObject({
      cached: true,
      results: [{ [contentField]: expect.stringContaining("Account A content") }],
    });
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer fixture-tavily-a", "Bearer fixture-tavily-b"]);
  },
);

describe("Tavily search cache TTL", () => {
  it("keeps extraction on its default TTL when search caching is disabled", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        results: [{ url: "https://example.com/extract-ttl", raw_content: "Body" }],
      }),
    );
    const tool = captureTavilyTools({
      tools: { web: { search: { cacheTtlMinutes: 0 } } },
      plugins: { entries: { tavily: { config: { webSearch: { apiKey: "extract-ttl-key" } } } } },
    })("tavily_extract");
    const extract = async () =>
      (await tool.execute("extract-cache", { urls: ["https://example.com/extract-ttl"] })).details;

    expect(await extract()).not.toHaveProperty("cached");
    expect(await extract()).toMatchObject({ cached: true });
    expect(fetch).toHaveBeenCalledOnce();
    now += 15 * 60_000;
    expect(await extract()).not.toHaveProperty("cached");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { kind: "web_search", cacheTtlMinutes: 1 },
    { kind: "tavily_search", cacheTtlMinutes: 0 },
  ])(
    "$kind applies the current $cacheTtlMinutes-minute TTL to cached results",
    async ({ kind, cacheTtlMinutes }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      let requests = 0;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        requests += 1;
        return Response.json({
          results: [
            {
              title: `Result ${requests}`,
              url: `https://example.com/${requests}`,
              content: `Body ${requests}`,
            },
          ],
        });
      });
      const search = async (ttl: number) => {
        const searchConfig = { cacheTtlMinutes: ttl };
        const config = {
          tools: { web: { search: searchConfig } },
          plugins: {
            entries: { tavily: { config: { webSearch: { apiKey: "tavily-test-key" } } } },
          },
        };
        const query = `Tavily ${kind} current TTL ${cacheTtlMinutes}`;
        if (kind === "tavily_search") {
          const tool = captureTavilyTools(config)("tavily_search");
          return (await tool.execute("cache-ttl", { query })).details as Record<string, unknown>;
        }
        const tool = createTavilyWebSearchProvider().createTool({ config, searchConfig });
        if (!tool) {
          throw new Error("Expected Tavily search tool");
        }
        return await tool.execute({ query });
      };

      const original = await search(15);
      expect(await search(15)).toEqual({ ...original, cached: true });
      expect(fetch).toHaveBeenCalledTimes(1);

      if (cacheTtlMinutes > 0) {
        clock.mockReturnValue(Date.now() + 60_000);
      }
      const fresh = await search(cacheTtlMinutes);
      expect(fresh.cached).toBeUndefined();
      expect(fresh.results).toEqual([expect.objectContaining({ url: "https://example.com/2" })]);
      expect(fetch).toHaveBeenCalledTimes(2);

      if (cacheTtlMinutes === 0) {
        const next = await search(0);
        expect(next.cached).toBeUndefined();
        expect(next.results).toEqual([expect.objectContaining({ url: "https://example.com/3" })]);
        expect(await search(15)).toEqual({ ...original, cached: true });
        expect(fetch).toHaveBeenCalledTimes(3);
      } else {
        expect(await search(1)).toEqual({ ...fresh, cached: true });
        expect(fetch).toHaveBeenCalledTimes(2);
      }
    },
  );
});
