import { Check } from "typebox/value";
import { afterEach, assert, expect, it, vi } from "vitest";
import { captureTavilyTools } from "./tavily-tools.test-support.js";

const config = {
  tools: { web: { search: { cacheTtlMinutes: 0 } } },
  plugins: { entries: { tavily: { config: { webSearch: { apiKey: "fixture-tavily" } } } } },
};
afterEach(() => vi.restoreAllMocks());

function requestBody(init?: RequestInit): unknown {
  assert(typeof init?.body === "string", "Expected a serialized JSON request body");
  return JSON.parse(init.body);
}

it("sends current Search controls through the registered tool and preserves bounded metadata", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      results: [
        {
          url: "https://example.com/news",
          title: "Title",
          content: "text",
          published_date: "2026-10-27",
        },
      ],
      usage: { credits: 0 },
    }),
  );
  const tool = captureTavilyTools(config)("tavily_search");
  const args = {
    query: "news controls",
    search_depth: "fast",
    max_results: 1,
    include_answer: false,
    include_domains: ["example.com"],
    include_domains_mode: "prefer",
    language: "en",
    filter_by_language: true,
    safe_search: false,
    include_published_date: true,
    filter_by_published_date: false,
    start_date: "2026-10-01",
    end_date: "2026-10-27",
    exact_match: true,
    include_usage: true,
  };
  expect(Check(tool.parameters, args)).toBe(true);
  const result = await tool.execute("search", args);
  const [, init] = fetch.mock.calls[0]!;
  expect(requestBody(init)).toEqual(args);
  expect(new Headers(init?.headers).get("X-Client-Name")).toBe("openclaw");
  expect(new Headers(init?.headers).get("X-Client-Source")).toBe("api");
  expect(result.details).toMatchObject({
    count: 1,
    results: [{ published: "2026-10-27" }],
    usage: { credits: 0 },
  });
});

it("keeps omitted Search defaults and permits explicit zero results", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ results: [] }));
  const tool = captureTavilyTools(config)("tavily_search");
  await tool.execute("default", { query: "default options" });
  expect(requestBody(fetch.mock.calls[0]?.[1])).toEqual({
    query: "default options",
    max_results: 5,
  });
  const args = {
    query: "answer only",
    max_results: 0,
    include_answer: true,
    search_depth: "ultra-fast",
  };
  expect(Check(tool.parameters, args)).toBe(true);
  await tool.execute("zero", args);
  expect(requestBody(fetch.mock.calls[1]?.[1])).toEqual(args);
  expect(Check(tool.parameters, { query: "bad", max_results: -1 })).toBe(false);
});

it.each([
  { query: "invalid mode", include_domains_mode: "prefer" },
  { query: "invalid language", filter_by_language: true },
  { query: "invalid safe search", safe_search: true, search_depth: "ultra-fast" },
  { query: "invalid safe search", safe_search: true, search_depth: "fast" },
])("rejects unsupported combinations before HTTP: %j", async (args) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  await expect(
    captureTavilyTools(config)("tavily_search").execute("invalid", args),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("sends Extract controls with false values and retains safe favicon and usage metadata", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      results: [
        {
          url: "https://example.com/extract-options",
          raw_content: "x".repeat(25_000),
          favicon: "https://example.com/icon.png",
        },
      ],
      failed_results: [{ url: "https://example.com/failed", error: "fixture failure" }],
      usage: { credits: 0 },
    }),
  );
  const tool = captureTavilyTools(config)("tavily_extract");
  const args = {
    urls: ["https://example.com/extract-options"],
    format: "text",
    include_images: false,
    include_favicon: true,
    include_usage: true,
  };
  expect(Check(tool.parameters, args)).toBe(true);
  const result = await tool.execute("extract", args);
  const [, init] = fetch.mock.calls[0]!;
  expect(requestBody(init)).toEqual(args);
  expect(new Headers(init?.headers).get("X-Client-Name")).toBe("openclaw");
  expect(new Headers(init?.headers).get("X-Client-Source")).toBe("api");
  expect(result.details).toMatchObject({
    truncated: true,
    results: [{ favicon: "https://example.com/icon.png" }],
    failedResults: [{ error: expect.stringContaining("fixture failure") }],
    usage: { credits: 0 },
  });
  expect(JSON.stringify(result.details).length).toBeLessThan(22_000);
});

it.each([
  ["include_domains_mode", "prefer"],
  ["language", "en"],
  ["filter_by_language", true],
  ["safe_search", true],
  ["include_published_date", true],
  ["filter_by_published_date", true],
  ["start_date", "2026-10-01"],
  ["end_date", "2026-10-27"],
  ["exact_match", true],
  ["include_usage", true],
] as const)("separates Search cache entries for %s", async (key, value) => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ results: [] }));
  const tool = captureTavilyTools({
    ...config,
    tools: { web: { search: { cacheTtlMinutes: 15 } } },
  })("tavily_search");
  const base = { query: `cache ${key}`, include_domains: ["example.com"], language: "fr" };
  await tool.execute("base", base);
  await tool.execute("changed", { ...base, [key]: value });
  await tool.execute("cached", { ...base, [key]: value });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  ["format", "text"],
  ["include_favicon", true],
  ["include_usage", true],
] as const)("separates Extract cache entries for %s", async (key, value) => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ results: [] }));
  const tool = captureTavilyTools(config)("tavily_extract");
  const base = { urls: [`https://example.com/cache-${key}`] };
  await tool.execute("base", base);
  await tool.execute("changed", { ...base, [key]: value });
  await tool.execute("cached", { ...base, [key]: value });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["search", "extract"] as const)(
  "attributes %s using separate integration and transport headers",
  async (kind) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
    const args =
      kind === "search"
        ? { query: "attribution fixture" }
        : { urls: ["https://example.com/attribution"] };
    await captureTavilyTools(config)(`tavily_${kind}`).execute("headers", args);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Client-Name")).toBe("openclaw");
    expect(headers.get("X-Client-Source")).toBe("api");
  },
);
