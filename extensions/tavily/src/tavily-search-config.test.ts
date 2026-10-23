/* Start By Cursor Rule, csjg8ah9884ye1ru37qo6iroqwl8waao */
import type { MockInstance } from "vitest";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createTavilyWebSearchProvider } from "./tavily-search-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createConfiguredSearchTool(searchConfig?: Record<string, unknown>) {
  const tool = createTavilyWebSearchProvider().createTool({
    config: {
      plugins: { entries: { tavily: { config: { webSearch: { apiKey: "fixture-tavily-key" } } } } },
      tools: { web: { search: { cacheTtlMinutes: 0 } } },
    },
    searchConfig,
  });
  assert(tool, "Expected Tavily search tool");
  return tool;
}

function mockTavilyFetchWithResults(resultCount: number) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      results: Array.from({ length: resultCount }, (_, index) => ({
        url: `https://example.com/${index + 1}`,
        title: `Result ${index + 1}`,
        content: `Result ${index + 1} content`,
      })),
    }),
  );
}

function readTavilyRequestBody(fetchMock: MockInstance<typeof globalThis.fetch>) {
  const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
  expect(typeof rawBody).toBe("string");
  return JSON.parse(rawBody as string) as Record<string, unknown>;
}

it("honors tools.web.search maxResults at the request boundary", async () => {
  const fetchMock = mockTavilyFetchWithResults(5);
  const tool = createConfiguredSearchTool({ maxResults: 2, timeoutSeconds: 2 });
  const result = (await tool.execute({ query: "configured max results" })) as {
    count?: number;
  };
  expect(readTavilyRequestBody(fetchMock).max_results).toBe(2);
  expect(result.count).toBe(2);
});

it("keeps an explicit count ahead of the configured maxResults", async () => {
  const fetchMock = mockTavilyFetchWithResults(5);
  const tool = createConfiguredSearchTool({ maxResults: 1, timeoutSeconds: 2 });
  await tool.execute({ query: "explicit count wins", count: 3 });
  expect(readTavilyRequestBody(fetchMock).max_results).toBe(3);
});

it("keeps the client default count when no search config is set", async () => {
  const fetchMock = mockTavilyFetchWithResults(5);
  const tool = createConfiguredSearchTool();
  await tool.execute({ query: "client default count" });
  expect(readTavilyRequestBody(fetchMock).max_results).toBe(5);
});

it("cancels a slow Tavily search at the configured deadline", async () => {
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
  try {
    const pending = expect(tool.execute({ query: "deadline enforcement" })).rejects.toThrow(
      /timed out|TimeoutError|aborted/i,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
  } finally {
    vi.useRealTimers();
  }
});
/* End By Cursor Rule, csjg8ah9884ye1ru37qo6iroqwl8waao */
