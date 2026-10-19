import type { MockInstance } from "vitest";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";
import { createExaWebSearchProvider } from "../web-search-contract-api.js";

type JsonRecord = Record<string, unknown>;
let fetchMock: MockInstance<typeof fetch>;
const validationErrors = {
  invalid_base_url:
    "plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/exa",
  invalid_contents: "contents.highlights.numSentences must be a positive integer.",
  conflicting_time_filters:
    "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
  invalid_date: "date_after must be YYYY-MM-DD format.",
};

function requireExaTool(webSearch: JsonRecord = {}, searchConfig: JsonRecord = {}) {
  const exa = { config: { webSearch: { apiKey: "exa-test-key", ...webSearch } } };
  const tool = createExaWebSearchProvider().createTool({
    config: { plugins: { entries: { exa } } },
    searchConfig,
  });
  if (!tool) {
    throw new Error("Expected Exa tool definition");
  }
  return tool;
}

async function expectSearchFailure(response: Response, query: string, message: string) {
  fetchMock.mockResolvedValue(response);
  const result = requireExaTool({}, { cacheTtlMinutes: 0 }).execute({ query });
  await expect(result).rejects.toThrow(message);
  expect(fetchMock).toHaveBeenCalledOnce();
}

function respondWith(results: JsonRecord[]) {
  fetchMock.mockImplementation(async () => Response.json({ results }));
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("caps returned and cached results when Exa exceeds the requested count", async () => {
  respondWith([
    { url: "https://example.com/first", title: "First" },
    { url: "https://example.com/second" },
  ]);
  const tool = requireExaTool();
  const args = { query: "exa result count owner", count: 1 };
  const first = await tool.execute(args);
  expect(await tool.execute(args)).toEqual({ ...first, cached: true });

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
    '{"query":"exa result count owner","numResults":1,"type":"auto","contents":{"highlights":true}}',
  );
  expect(first).toMatchObject({
    provider: "exa",
    count: 1,
    results: [
      { url: "https://example.com/first", title: expect.stringMatching(/\n---\nFirst\n<<<END/) },
    ],
  });
});

it.each(["before", "during"])("preserves cancellation %s transport", async (timing) => {
  const controller = new AbortController();
  const reason = new Error(`Exa canceled ${timing} transport`);
  fetchMock.mockImplementation(async (_url, init) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Exa request lost caller cancellation");
    }
    signal.throwIfAborted();
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          const abortReason: unknown = signal.reason;
          reject(
            abortReason instanceof Error
              ? abortReason
              : new Error("Exa request lost caller cancellation reason"),
          );
        },
        { once: true },
      );
      // Cancel at transport entry, after cold runtime loading has completed.
      controller.abort(reason);
      expect(signal.aborted).toBe(true);
    });
  });
  if (timing === "before") {
    controller.abort(reason);
  }
  const result = requireExaTool().execute(
    { query: `cancel ${timing}` },
    { signal: controller.signal },
  );
  onTestFinished(async () => {
    controller.abort(reason);
    await result.catch(() => {});
  });

  await expect(result).rejects.toBe(reason);
  expect(fetchMock).toHaveBeenCalledTimes(timing === "before" ? 0 : 1);
  if (timing === "during") {
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  }
});

it("applies scoped auth, endpoint, contents, freshness, and result normalization at the tool boundary", async () => {
  respondWith([
    { highlights: ["first", "", "second"], text: "ignored" },
    { text: "text fallback" },
  ]);
  const makeTool = (baseUrl?: string) =>
    requireExaTool({ apiKey: "exa-config-key", baseUrl }, { maxResults: 120 });
  const tool = makeTool("https://proxy.example/exa/");

  const args = {
    query: "Exa boundary",
    freshness: "month",
    contents: {
      text: { maxCharacters: 1200 },
      highlights: { maxCharacters: 4000, query: "q", numSentences: 4, highlightsPerUrl: 2 },
      summary: { query: "launch" },
    },
  };
  const result = await tool.execute(args);
  expect(
    (result.results as Array<{ description: string }>).map(
      ({ description }) => description.split("\n---\n")[1]?.split("\n<<<END")[0],
    ),
  ).toEqual(["first\nsecond", "text fallback"]);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example/exa/search");
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-api-key": "exa-config-key" });
  const rawBodyAt = (index: number) => {
    const body = fetchMock.mock.calls[index]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected Exa JSON request body");
    }
    return body;
  };
  const bodyAt = (index = fetchMock.mock.calls.length - 1) => JSON.parse(rawBodyAt(index));
  expect(
    rawBodyAt(0).replace(/"startPublishedDate":"[^"]*"/, '"startPublishedDate":"<dynamic-date>"'),
  ).toBe(
    '{"query":"Exa boundary","numResults":100,"type":"auto","contents":{"text":{"maxCharacters":1200},"highlights":{"maxCharacters":4000,"query":"q","numSentences":4,"highlightsPerUrl":2},"summary":{"query":"launch"}},"startPublishedDate":"<dynamic-date>"}',
  );
  expect(Date.parse(bodyAt(0).startPublishedDate)).not.toBeNaN();

  await tool.execute({ query: "cache partitions" });
  await tool.execute({ query: "cache partitions", contents: { highlights: true } });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await tool.execute({ query: "cache partitions", contents: { highlights: false } });
  await tool.execute({ query: "cache partitions", contents: { text: false } });
  await tool.execute({ query: "cache partitions", contents: { summary: false } });
  const defaultTool = makeTool();
  await defaultTool.execute(args);
  await makeTool("proxy.example/exa/search/").execute({ ...args, query: "bare endpoint" });
  expect(fetchMock.mock.calls[5]?.[0]).toBe("https://api.exa.ai/search");
  expect(fetchMock.mock.calls[6]?.[0]).toBe("https://proxy.example/exa/search");

  for (const [count, expected] of [
    ["+05", 5],
    ["2e1", 20],
  ] as const) {
    await defaultTool.execute({ query: `count ${count}`, count });
    expect(bodyAt().numResults).toBe(expected);
  }
  for (const count of ["0x10", 1.5]) {
    await expect(defaultTool.execute({ query: `count ${count}`, count })).rejects.toThrow(
      "count must be an integer from 1 to 100",
    );
  }
  const inheritedText = { maxCharacters: 1 };
  const inheritedPrototype = Object.defineProperty({}, "query", {
    get: () => {
      throw new Error("read");
    },
  });
  Object.setPrototypeOf(inheritedText, inheritedPrototype);
  await defaultTool.execute({ query: "inherited", contents: { text: inheritedText } });
  expect(bodyAt().contents).toEqual({ text: { maxCharacters: 1 } });
});

it.each([
  ["invalid_base_url", {}, { baseUrl: "ftp://proxy.example/exa" }],
  ["invalid_contents", { contents: { highlights: { numSentences: 0 } } }, {}],
  ["conflicting_time_filters", { freshness: "day", date_after: "2026-03-01" }, {}],
  ["invalid_date", { date_after: "2026-02-31" }, {}],
] as const)("returns %s", async (error, args, webSearch) => {
  await expect(
    requireExaTool(webSearch).execute({ query: "validation", ...args }),
  ).resolves.toEqual({
    error,
    message: validationErrors[error],
    docs: `https://docs.openclaw.ai/tools/${error === "invalid_base_url" ? "exa-search" : "web"}`,
  });
});

it.each([0, 1])("honors the current cache TTL %s", async (cacheTtlMinutes) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let requestCount = 0;
  fetchMock.mockImplementation(async () =>
    Response.json({ results: [{ url: `https://example.com/${++requestCount}` }] }),
  );
  const cachedTool = requireExaTool({}, { cacheTtlMinutes: 15 });
  const currentTool = requireExaTool({}, { cacheTtlMinutes });
  const args = { query: `exa cache TTL ${cacheTtlMinutes}` };

  const original = await cachedTool.execute(args);
  expect(original).toMatchObject({ results: [{ url: "https://example.com/1" }] });
  expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  clock.mockReturnValue(now + 60_000);
  const fresh = await currentTool.execute(args);
  expect(fresh).toMatchObject({ results: [{ url: "https://example.com/2" }] });
  expect(fresh).not.toHaveProperty("cached");
  expect(fetchMock).toHaveBeenCalledTimes(2);

  if (cacheTtlMinutes === 0) {
    const uncached = await currentTool.execute(args);
    expect(uncached).toMatchObject({ results: [{ url: "https://example.com/3" }] });
    expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
  } else {
    expect(await currentTool.execute(args)).toEqual({ ...fresh, cached: true });
  }
  expect(fetchMock).toHaveBeenCalledTimes(cacheTtlMinutes === 0 ? 3 : 2);
});

it.each([
  ["malformed JSON", "{ nope"],
  // A quoted invalid byte: valid JSON if decoded non-fatally.
  ["invalid UTF-8", new Uint8Array([34, 0xff, 34])],
] as const)("rejects %s with a stable provider error", async (query, body) => {
  await expectSearchFailure(new Response(body), query, "Exa API returned malformed JSON");
});

it("cancels oversized Exa JSON before buffering it all", async () => {
  const streamed = createStreamingResponse({ chunkCount: 32, chunkSize: 1024 * 1024 });
  await expectSearchFailure(
    streamed.response,
    "oversized Exa JSON",
    "Exa API response exceeds 16777216 bytes",
  );
  expect(streamed.getReadCount()).toBeLessThan(32);
  expect(streamed.wasCanceled()).toBe(true);
});

it("bounds Exa API error bodies without using response.text()", async () => {
  const tracked = cancelTrackedTextResponse(`${"upstream ".repeat(2048)}tail`, { status: 503 });
  const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
  fetchMock
    .mockResolvedValueOnce(tracked.response)
    .mockResolvedValueOnce(new Response("short", { status: 503 }));
  const tool = requireExaTool({}, { cacheTtlMinutes: 0 });

  const failure = tool.execute({ query: "bounded Exa error" });
  await expect(failure).rejects.toMatchObject({
    message: expect.stringContaining("upstream"),
    status: 503,
    statusCode: 503,
  });
  await expect(failure).rejects.not.toThrow("tail");
  await expect(tool.execute({ query: "short Exa error" })).rejects.toMatchObject({
    message: "Exa API error (503): short",
    status: 503,
    statusCode: 503,
  });
  expect(tracked.wasCanceled()).toBe(true);
  expect(textSpy).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
