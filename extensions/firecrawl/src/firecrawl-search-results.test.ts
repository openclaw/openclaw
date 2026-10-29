import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import type { MockInstance } from "vitest";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
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

function createConfiguredSearchTool(searchConfig?: Record<string, unknown>) {
  const tool = createFirecrawlFreeWebSearchProvider().createTool({
    config: { tools: { web: { search: { cacheTtlMinutes: 0 } } } },
    searchConfig,
  });
  assert(tool, "Expected Firecrawl search tool");
  return tool;
}

function readFirecrawlRequestBody(fetchMock: MockInstance<typeof globalThis.fetch>) {
  const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
  expect(typeof rawBody).toBe("string");
  return JSON.parse(rawBody as string) as Record<string, unknown>;
}

function mockFirecrawlFetchWithEmptyWeb() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ web: [] }), {
      headers: { "content-type": "application/json" },
    }),
  );
}

it("honors tools.web.search maxResults at the request boundary", async () => {
  const fetchMock = mockFirecrawlFetchWithEmptyWeb();
  const tool = createConfiguredSearchTool({ maxResults: 2, timeoutSeconds: 2 });
  await tool.execute({ query: "openclaw docs" });
  expect(readFirecrawlRequestBody(fetchMock).limit).toBe(2);
});

it("keeps an explicit count ahead of the configured maxResults", async () => {
  const fetchMock = mockFirecrawlFetchWithEmptyWeb();
  const tool = createConfiguredSearchTool({ maxResults: 2, timeoutSeconds: 2 });
  await tool.execute({ query: "openclaw docs", count: 4 });
  expect(readFirecrawlRequestBody(fetchMock).limit).toBe(4);
});

it("keeps the client default count when no search config is set", async () => {
  const fetchMock = mockFirecrawlFetchWithEmptyWeb();
  const tool = createConfiguredSearchTool();
  await tool.execute({ query: "openclaw docs" });
  expect(readFirecrawlRequestBody(fetchMock).limit).toBe(5);
});

it("cancels a slow Firecrawl search at the configured deadline", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
      }) as Promise<Response>,
  );
  const tool = createConfiguredSearchTool({ timeoutSeconds: 1 });
  vi.useFakeTimers();
  let pending: Promise<unknown> | undefined;
  try {
    let settled = false;
    pending = expect(
      tool.execute({ query: "openclaw docs" }).finally(() => {
        settled = true;
      }),
    ).rejects.toThrow(/timed out|TimeoutError|aborted/i);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled, "request must settle at its configured deadline").toBe(true);
    await pending;
  } finally {
    await vi.runOnlyPendingTimersAsync();
    await pending;
    vi.useRealTimers();
  }
});
