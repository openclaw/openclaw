import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";
import { createExaWebSearchProvider } from "../web-search-contract-api.js";

type JsonRecord = Record<string, unknown>;

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

function mockFetch(response: Response) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
}

async function expectSearchFailure(response: Response, query: string, message: string) {
  const fetchMock = mockFetch(response);
  const result = requireExaTool({}, { cacheTtlMinutes: 0 }).execute({ query });
  await expect(result).rejects.toThrow(message);
  expect(fetchMock).toHaveBeenCalledOnce();
}

const malformedJson = "Exa API returned malformed JSON";

describe("exa web search provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps returned and cached results when Exa exceeds the requested count", async () => {
    const fetchMock = mockFetch(
      Response.json({
        results: [
          { url: "https://example.com/first", title: "First", highlights: ["first"] },
          { url: "https://example.com/second", title: "Second", highlights: ["second"] },
          { url: "https://example.com/third", title: "Third", highlights: ["third"] },
        ],
      }),
    );
    const tool = requireExaTool();
    const args = { query: "exa result count owner", count: 1 };
    const first = await tool.execute(args);
    const cached = await tool.execute(args);

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
    expect(first.results).toHaveLength(1);
    expect(cached).toEqual({ ...first, cached: true });
  });

  it("does not send or cache an already canceled search", async () => {
    const fetchMock = mockFetch(Response.json({ results: [] }));
    const controller = new AbortController();
    controller.abort(new Error("Exa caller canceled"));

    await expect(
      requireExaTool().execute({ query: "exa pre-canceled" }, { signal: controller.signal }),
    ).rejects.toThrow("Exa caller canceled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the caller's in-flight abort reason", async ({ onTestFinished }) => {
    const controller = new AbortController();
    const reason = new Error("Exa request canceled in flight");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Exa request lost caller cancellation"));
            return;
          }
          const rejectAbort = () => {
            const abortReason: unknown = signal.reason;
            reject(
              abortReason instanceof Error
                ? abortReason
                : new Error("Exa request lost caller cancellation reason"),
            );
          };
          if (signal.aborted) {
            rejectAbort();
            return;
          }
          signal.addEventListener("abort", rejectAbort, { once: true });
          // Cancel at transport entry, after cold runtime loading has completed.
          controller.abort(reason);
          expect(signal.aborted).toBe(true);
        }),
    );
    const result = requireExaTool().execute(
      { query: "exa in-flight cancellation" },
      { signal: controller.signal },
    );
    onTestFinished(async () => {
      controller.abort(reason);
      await result.catch(() => {});
      fetchMock.mockRestore();
    });

    await expect(result).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("applies scoped auth, endpoint, contents, freshness, and result normalization at the tool boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        results: [
          {
            url: "https://example.test/highlights",
            highlights: ["first", "", "second"],
            text: "ignored",
          },
          { url: "https://example.test/text", text: "text fallback" },
        ],
      }),
    );
    const tool = requireExaTool(
      { apiKey: "exa-config-key", baseUrl: "https://proxy.example/exa/" },
      { maxResults: 120 },
    );

    const args = {
      query: "Exa boundary",
      freshness: "month",
      contents: {
        text: { maxCharacters: 1200 },
        highlights: {
          maxCharacters: 4000,
          query: "latest model launches",
          numSentences: 4,
          highlightsPerUrl: 2,
        },
        summary: { query: "launch details" },
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
      '{"query":"Exa boundary","numResults":100,"type":"auto","contents":{"text":{"maxCharacters":1200},"highlights":{"maxCharacters":4000,"query":"latest model launches","numSentences":4,"highlightsPerUrl":2},"summary":{"query":"launch details"}},"startPublishedDate":"<dynamic-date>"}',
    );
    expect(Date.parse(bodyAt(0).startPublishedDate)).not.toBeNaN();

    await tool.execute({ query: "cache partitions" });
    await tool.execute({ query: "cache partitions", contents: { highlights: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tool.execute({ query: "cache partitions", contents: { highlights: false } });
    await tool.execute({ query: "cache partitions", contents: { text: false } });
    await tool.execute({ query: "cache partitions", contents: { summary: false } });
    const defaultTool = requireExaTool({ apiKey: "exa-config-key" }, { maxResults: 120 });
    await defaultTool.execute(args);
    await requireExaTool(
      { apiKey: "exa-config-key", baseUrl: "proxy.example/exa/search/" },
      { maxResults: 120 },
    ).execute({ ...args, query: "bare endpoint" });
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
    [
      { baseUrl: "ftp://proxy.example/exa" },
      {},
      "invalid_base_url",
      "plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/exa",
    ],
    [
      {},
      { contents: { highlights: { numSentences: 0 } } },
      "invalid_contents",
      "contents.highlights.numSentences must be a positive integer.",
    ],
    [
      {},
      { freshness: "day", date_after: "2026-03-01" },
      "conflicting_time_filters",
      "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
    ],
    [{}, { date_after: "2026-02-31" }, "invalid_date", "date_after must be YYYY-MM-DD format."],
  ])("returns public validation errors", async (webSearch, args, error, message) => {
    await expect(
      requireExaTool(webSearch).execute({ query: "validation", ...args }),
    ).resolves.toEqual({
      error,
      message,
      docs: `https://docs.openclaw.ai/tools/${error === "invalid_base_url" ? "exa-search" : "web"}`,
    });
  });

  it.each([0, 1])("honors the current cache TTL %s", async (cacheTtlMinutes) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let requestCount = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ results: [{ url: `https://example.com/result-${++requestCount}` }] }),
      );
    const cachedTool = requireExaTool({}, { cacheTtlMinutes: 15 });
    const currentTool = requireExaTool({}, { cacheTtlMinutes });
    const args = { query: `exa cache TTL ${cacheTtlMinutes}` };

    const original = await cachedTool.execute(args);
    expect(original).toMatchObject({ results: [{ url: "https://example.com/result-1" }] });
    expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + 60_000);
    const fresh = await currentTool.execute(args);
    expect(fresh).toMatchObject({ results: [{ url: "https://example.com/result-2" }] });
    expect(fresh).not.toHaveProperty("cached");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    if (cacheTtlMinutes === 0) {
      expect(await currentTool.execute(args)).toMatchObject({
        results: [{ url: "https://example.com/result-3" }],
      });
      expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } else {
      expect(await currentTool.execute(args)).toEqual({ ...fresh, cached: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("reports malformed Exa API JSON with a stable provider error", async () => {
    await expectSearchFailure(new Response("{ nope"), "malformed Exa JSON", malformedJson);
  });

  it("rejects invalid UTF-8 in Exa search JSON", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const body = new Uint8Array([
      ...encode('{"results":[{"url":"https://example.com","title":"bad'),
      0xff,
      ...encode('"}]}'),
    ]);
    await expectSearchFailure(new Response(body), "invalid UTF-8 Exa JSON", malformedJson);
  });

  it("caps oversized Exa search JSON instead of buffering the whole body", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "a",
      headers: { "content-type": "application/json" },
    });
    await expectSearchFailure(
      streamed.response,
      "oversized Exa JSON",
      "Exa API response exceeds 16777216 bytes",
    );
    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("bounds Exa API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(`${"exa upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tracked.response)
      .mockResolvedValueOnce(new Response("short", { status: 503 }));
    const tool = requireExaTool({}, { cacheTtlMinutes: 0 });

    const failure = tool.execute({ query: "bounded Exa error" });
    await expect(failure).rejects.toThrow("exa upstream unavailable");
    await expect(failure).rejects.toMatchObject({ status: 503, statusCode: 503 });
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
});
