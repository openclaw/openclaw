import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFirecrawlFreeWebSearchProvider } from "./firecrawl-search-provider.js";

const first = { url: "https://example.com/first", title: "First" };
const second = { url: "https://example.com/second", title: "Second" };

installPinnedHostnameTestHooks();

afterEach(() => {
  vi.restoreAllMocks();
});

async function search(payload: Record<string, unknown>, count = 10) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(payload));
  const tool = createFirecrawlFreeWebSearchProvider().createTool({
    config: { tools: { web: { search: { cacheTtlMinutes: 0 } } } },
  });
  if (!tool) {
    throw new Error("Expected Firecrawl search tool");
  }
  return await tool.execute({ query: "Firecrawl result selection", count });
}

describe("Firecrawl search result selection", () => {
  it.each([
    { data: { news: [first] } },
    { data: { images: [first] } },
    { data: { web: [], news: [first] } },
  ])("preserves source-specific results: %j", async (payload) => {
    expect(await search(payload)).toMatchObject({ count: 1, results: [{ url: first.url }] });
  });

  it("combines populated Firecrawl source arrays", async () => {
    expect(await search({ data: { web: [first], news: [second] } })).toMatchObject({
      count: 2,
      results: [{ url: first.url }, { url: second.url }],
    });
  });

  it("finds the last supported envelope after malformed candidates", async () => {
    expect(
      await search({ data: false, results: "invalid", web: { results: [first] } }),
    ).toMatchObject({ count: 1, results: [{ url: first.url }] });
  });

  it("keeps an empty winning array instead of selecting a later envelope", async () => {
    expect(
      await search({
        data: { results: [], data: [first], web: [first] },
        web: { results: [first] },
      }),
    ).toMatchObject({ count: 0, results: [] });
  });

  it("counts objects with invalid URLs toward the scan cap after skipping primitive rows", async () => {
    const result = await search({
      data: [
        ...Array.from({ length: 150 }, () => null),
        ...Array.from({ length: 99 }, () => ({ url: "invalid", sourceURL: second.url })),
        first,
        second,
      ],
    });

    expect(result).toMatchObject({ count: 1, results: [{ url: first.url }] });
  });

  it("bounds canonical result URLs after percent-encoding Unicode", async () => {
    const expandedUrl = `https://example.com/${"🦀".repeat(1_000)}`;
    expect(expandedUrl.length).toBeLessThan(2_048);

    const result = await search({
      data: [
        { title: "too large", url: expandedUrl },
        { title: "safe unicode", url: "https://example.com/🦀" },
      ],
    });

    expect(result).toMatchObject({
      count: 1,
      results: [{ url: "https://example.com/%F0%9F%A6%80" }],
    });
  });

  it("fills the requested count after invalid rows and preserves schema field fallbacks", async () => {
    const result = await search(
      {
        results: [second],
        data: [
          null,
          [],
          { url: "invalid" },
          {
            url: 7,
            sourceURL: first.url,
            title: false,
            description: [],
            snippet: "Fallback snippet",
            publishedDate: "invalid",
            metadata: { title: "Fallback title", publishedTime: "2026-08-03" },
          },
          second,
        ],
      },
      1,
    );

    expect(result).toMatchObject({
      count: 1,
      results: [
        {
          url: first.url,
          title: expect.stringContaining("Fallback title"),
          description: expect.stringContaining("Fallback snippet"),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("2026-08-03");
  });
});
