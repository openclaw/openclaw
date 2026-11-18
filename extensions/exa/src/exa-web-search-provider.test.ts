import type { MockInstance } from "vitest";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";
import { createExaWebSearchProvider } from "../web-search-contract-api.js";

type JsonRecord = Record<string, unknown>;
let fetchMock: MockInstance<typeof fetch>;

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

function searchFailure(response: Response, query: string, apiKey = "exa-test-key") {
  fetchMock.mockResolvedValue(response);
  return requireExaTool({ apiKey }, { cacheTtlMinutes: 0 }).execute({ query });
}

async function expectHttpError(
  failure: Promise<unknown>,
  message: string | RegExp,
  absent?: string,
) {
  await expect(failure).rejects.toMatchObject({ status: 503, statusCode: 503 });
  await expect(failure).rejects.toThrow(message);
  if (absent) {
    await expect(failure).rejects.not.toThrow(absent);
  }
}

function respondWith(results: JsonRecord[]) {
  fetchMock.mockImplementation(async () => Response.json({ results }));
}

function requestBody(index = fetchMock.mock.calls.length - 1) {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected Exa JSON request body");
  }
  return JSON.parse(body);
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("caps returned and cached results when Exa exceeds the requested count", async () => {
  respondWith([{ url: "https://a.test", title: "First" }, {}]);
  const tool = requireExaTool();
  const args = { query: "exa result count owner", count: 1 };
  const first = await tool.execute(args);
  expect(await tool.execute(args)).toEqual({ ...first, cached: true });

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(requestBody().numResults).toBe(1);
  expect(first).toMatchObject({
    count: 1,
    results: [{ url: "https://a.test", title: expect.stringMatching(/\n---\nFirst\n<<<END/) }],
  });
});

it("shares cached answers only with the same resolved credential", async () => {
  fetchMock.mockImplementation(async (_url, init) => {
    const account = new Headers(init?.headers).get("x-api-key") === "fixture-exa-a" ? "a" : "b";
    return Response.json({ results: [{ url: `https://example.com/account-${account}` }] });
  });
  const args = { query: "Exa credential cache isolation" };
  const first = await requireExaTool({ apiKey: "fixture-exa-a" }).execute(args);
  const other = await requireExaTool({ apiKey: "fixture-exa-b" }).execute(args);
  const repeated = await requireExaTool({ apiKey: "fixture-exa-a" }).execute(args);

  expect(first).toMatchObject({ results: [{ url: "https://example.com/account-a" }] });
  expect(other).toMatchObject({ results: [{ url: "https://example.com/account-b" }] });
  expect(repeated).toEqual({ ...first, cached: true });
  expect(
    fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-api-key")),
  ).toEqual(["fixture-exa-a", "fixture-exa-b"]);
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
    });
  });
  if (timing === "before") {
    controller.abort(reason);
  }
  const result = requireExaTool().execute({ query: timing }, { signal: controller.signal });
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
  expect(requestBody(0)).toEqual({
    query: args.query,
    numResults: 100,
    type: "auto",
    contents: args.contents,
    startPublishedDate: expect.any(String),
  });
  expect(Date.parse(requestBody(0).startPublishedDate)).not.toBeNaN();

  await tool.execute({ query: "cache partitions" });
  await tool.execute({ query: "cache partitions", contents: { highlights: true } });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(requestBody().contents).toEqual({ highlights: true });
  await tool.execute({ query: "cache partitions", contents: { highlights: false } });
  await tool.execute({ query: "cache partitions", contents: { text: false } });
  await tool.execute({ query: "cache partitions", contents: { summary: false } });
  const defaultTool = makeTool();
  await defaultTool.execute(args);
  await makeTool("proxy.example/exa/search/").execute({ ...args, query: "bare endpoint" });
  expect(fetchMock.mock.calls[5]?.[0]).toBe("https://api.exa.ai/search");
  expect(fetchMock.mock.calls[6]?.[0]).toBe("https://proxy.example/exa/search");

  const inheritedText = { maxCharacters: 1 };
  const inheritedPrototype = Object.defineProperty({}, "query", {
    get: () => {
      throw new Error("read");
    },
  });
  Object.setPrototypeOf(inheritedText, inheritedPrototype);
  await defaultTool.execute({ query: "inherited", contents: { text: inheritedText } });
  expect(requestBody().contents).toEqual({ text: { maxCharacters: 1 } });
});

it.each([
  ["invalid_contents", { contents: { highlights: { numSentences: 0 } } }],
  ["conflicting_time_filters", { freshness: "day", date_after: "2026-03-01" }],
  ["invalid_date", { date_after: "2026-02-31" }],
] as const)("returns %s", async (error, args) => {
  await expect(requireExaTool().execute({ query: "validation", ...args })).resolves.toHaveProperty(
    "error",
    error,
  );
});

it.each([
  "ftp://fixture-user:fixture-url-password@proxy.example/exa?api_key=fixture-query-token",
  "fixture-user:fixture-url-password@proxy.example:invalid/exa?api_key=fixture-query-token",
])("redacts credentials from rejected custom endpoint %s", async (baseUrl) => {
  const result = await requireExaTool({ baseUrl }).execute({ query: "invalid endpoint" });
  expect(result).toMatchObject({
    error: "invalid_base_url",
    message: "plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL.",
  });
  expect(fetchMock).not.toHaveBeenCalled();
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

  clock.mockReturnValue(now + 60_000);
  const fresh = await currentTool.execute(args);
  expect(fresh).toMatchObject({ results: [{ url: "https://example.com/2" }] });
  expect(fresh).not.toHaveProperty("cached");

  if (cacheTtlMinutes === 0) {
    const uncached = await currentTool.execute(args);
    expect(uncached).toMatchObject({ results: [{ url: "https://example.com/3" }] });
    expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
  } else {
    expect(await currentTool.execute(args)).toEqual({ ...fresh, cached: true });
  }
});

it.each([
  ["malformed JSON", "{ nope"],
  // A quoted invalid byte: valid JSON if decoded non-fatally.
  ["invalid UTF-8", new Uint8Array([34, 0xff, 34])],
] as const)("rejects %s with a stable provider error", async (query, body) => {
  await expect(searchFailure(new Response(body), query)).rejects.toThrow(
    "Exa API returned malformed JSON",
  );
});

it("cancels oversized Exa JSON before buffering it all", async () => {
  const streamed = createStreamingResponse({ chunkCount: 32, chunkSize: 1024 * 1024 });
  await expect(searchFailure(streamed.response, "oversized Exa JSON")).rejects.toThrow(
    "Exa API response exceeds 16777216 bytes",
  );
  expect(streamed.getReadCount()).toBeLessThan(32);
  expect(streamed.wasCanceled()).toBe(true);
});

it("bounds Exa API error bodies without using response.text()", async () => {
  const tracked = cancelTrackedTextResponse(`${"upstream ".repeat(2048)}tail`, { status: 503 });
  const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
  await expectHttpError(searchFailure(tracked.response, "bounded Exa error"), "upstream", "tail");
  await expectHttpError(
    searchFailure(new Response("short", { status: 503 }), "short Exa error"),
    /^Exa API error \(503\): short$/,
  );
  expect(tracked.wasCanceled()).toBe(true);
  expect(textSpy).not.toHaveBeenCalled();
});

it.each(["body", "statusText"])("redacts the active credential reflected in %s", async (source) => {
  const apiKey = "fixture-exa-opaque-credential";
  const detail = `upstream rejected ${apiKey}`;
  const failure = searchFailure(
    new Response(source === "body" ? detail : "", {
      status: 503,
      statusText: source === "statusText" ? detail : "Unavailable",
    }),
    `reflected credential ${source}`,
    apiKey,
  );

  await expectHttpError(failure, "upstream rejected", apiKey);
});
