import { afterEach, assert, expect, it, vi } from "vitest";
import { createTavilyWebSearchProvider } from "./tavily-search-provider.js";
import { captureTavilyTools } from "./tavily-tools.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function runTool(
  kind: string,
  apiKey: string,
  args: Record<string, unknown>,
  cacheTtlMinutes?: number,
) {
  const searchConfig = { cacheTtlMinutes };
  const config = {
    tools: { web: { search: searchConfig } },
    plugins: { entries: { tavily: { config: { webSearch: { apiKey } } } } },
  };
  if (kind !== "web_search") {
    const { details } = await captureTavilyTools(config)(kind).execute("cache", args);
    return details as Record<string, unknown>;
  }
  const tool = createTavilyWebSearchProvider().createTool({ config, searchConfig });
  assert(tool, "Expected Tavily search tool");
  return tool.execute(args);
}

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
    const args =
      kind === "tavily_extract"
        ? { urls: ["https://example.com/shared"] }
        : { query: `Tavily ${kind} credential cache isolation` };
    const run = (apiKey: string) => runTool(kind, apiKey, args);
    const first = await run("fixture-tavily-a");
    const other = await run("fixture-tavily-b");
    const repeated = await run("fixture-tavily-a");
    const contentField = kind === "tavily_extract" ? "rawContent" : "snippet";

    const results = (account: string) => [{ [contentField]: expect.stringContaining(account) }];
    expect([first, other, repeated]).toMatchObject([
      { results: results("Account A content") },
      { results: results("Account B content") },
      { cached: true, results: results("Account A content") },
    ]);
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer fixture-tavily-a", "Bearer fixture-tavily-b"]);
  },
);

it("keeps extraction on its default TTL when search caching is disabled", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const url = "https://example.com/extract-ttl";
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ results: [{ url, raw_content: "Body" }] }));
  const extract = () => runTool("tavily_extract", "extract-ttl-key", { urls: [url] }, 0);

  expect(await extract()).not.toHaveProperty("cached");
  expect(await extract()).toMatchObject({ cached: true });
  expect(fetch).toHaveBeenCalledOnce();
  now += 15 * 60_000;
  expect(await extract()).not.toHaveProperty("cached");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  ["web_search", 1],
  ["tavily_search", 0],
] as const)(
  "%s applies the current %i-minute TTL to cached results",
  async (kind, cacheTtlMinutes) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    let requests = 0;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ results: [{ url: `https://example.com/${++requests}` }] }),
      );
    const query = `Tavily ${kind} current TTL ${cacheTtlMinutes}`;
    const search = (ttl: number) => runTool(kind, "tavily-test-key", { query }, ttl);

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
