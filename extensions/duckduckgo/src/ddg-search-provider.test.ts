import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";
import { createDuckDuckGoWebSearchProvider } from "../web-search-contract-api.js";
import { resolveDdgRegion, resolveDdgSafeSearch } from "./config.js";
import { runDuckDuckGoSearch } from "./ddg-client.js";

describe("duckduckgo web search provider", () => {
  beforeAll(async () => {
    await import("../index.js");
  });

  afterEach(() => vi.restoreAllMocks());

  function createSearchTool(config: OpenClawConfig = {}) {
    const tool = createDuckDuckGoWebSearchProvider().createTool({ config });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    return tool;
  }

  function pluginConfig(webSearch: { region?: string; safeSearch?: string }) {
    return { plugins: { entries: { duckduckgo: { config: { webSearch } } } } };
  }

  function htmlResponse(html: string) {
    return new Response(html, { headers: { "content-type": "text/html" } });
  }

  function mockHtml(html: string) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(html));
  }

  async function runHtmlSearch(query: string, html: string) {
    mockHtml(html);
    return await runDuckDuckGoSearch({ query, cacheTtlMinutes: 0 });
  }

  function expectResults(
    payload: Record<string, unknown>,
    rows: [url: string, title: string, snippet: string, siteName?: string][],
  ) {
    expect(payload.results).toMatchObject(
      rows.map(([url, title, snippet, siteName]) => ({
        url,
        title: expect.stringContaining(title),
        snippet: expect.stringContaining(snippet),
        ...(siteName ? { siteName } : {}),
      })),
    );
  }

  it("rejects fractional and out-of-range counts before searching", async () => {
    const tool = createSearchTool();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected search"));
    const error = "count must be an integer from 1 to 10.";
    await expect(tool.execute({ query: "openclaw docs", count: 4.5 })).rejects.toThrow(error);
    await expect(tool.execute({ query: "openclaw docs", count: 11 })).rejects.toThrow(error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an already canceled search without fetching", async () => {
    const tool = createSearchTool();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected search"));
    const canceled = new AbortController();
    canceled.abort(new Error("DuckDuckGo caller canceled"));
    await expect(
      tool.execute({ query: "duckduckgo pre-canceled" }, { signal: canceled.signal }),
    ).rejects.toThrow("DuckDuckGo caller canceled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight DuckDuckGo request without caching its result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("DuckDuckGo request lost caller cancellation");
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const tool = createSearchTool();
    const query = "duckduckgo in-flight cancellation";
    const result = tool.execute({ query }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error("DuckDuckGo request canceled in flight"));
    await expect(result).rejects.toThrow("DuckDuckGo request canceled in flight");
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    fetchMock.mockResolvedValueOnce(
      htmlResponse('<a class="result__a" href="https://example.com">Example</a>'),
    );
    await tool.execute({ query });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves HTTP status for search failure guidance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(
      runDuckDuckGoSearch({ query: "duckduckgo rate limited", cacheTtlMinutes: 0 }),
    ).rejects.toMatchObject({
      status: 429,
      statusCode: 429,
      message: "DuckDuckGo search error (429): rate limited",
    });
  });

  it("bounds successful DuckDuckGo HTML bodies without using response.text()", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "Content-Type": "text/html" },
    });
    const textSpy = vi.spyOn(streamed.response, "text").mockRejectedValue(new Error("unbounded"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamed.response);
    await expect(
      runDuckDuckGoSearch({ query: "duckduckgo bounded response", cacheTtlMinutes: 0 }),
    ).rejects.toThrow("DuckDuckGo search: text response exceeds 16777216 bytes");
    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("reads region from plugin config and normalizes empty values away", () => {
    expect(resolveDdgRegion(pluginConfig({ region: "de-de" }))).toBe("de-de");
    expect(resolveDdgRegion(pluginConfig({ region: "   " }))).toBeUndefined();
  });

  it("defaults safeSearch to moderate and accepts strict and off", () => {
    expect(resolveDdgSafeSearch(undefined)).toBe("moderate");
    expect(resolveDdgSafeSearch(pluginConfig({ safeSearch: "strict" }))).toBe("strict");
    expect(resolveDdgSafeSearch(pluginConfig({ safeSearch: "off" }))).toBe("off");
  });

  it("parses href-before-class results without splitting highlighted words", async () => {
    const payload = await runHtmlSearch(
      "duckduckgo href ordering",
      `
        <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com" class="result__a">
          Example &#38; Co Caf<b>é</b> guide
        </a>
        <a class="result__snippet">Fast&nbsp;search &hellip; with caf<b>é</b> details</a>
        <a class="result__a" href="https://example.org/direct">Direct result</a>
        <a class="result__snippet">Second snippet</a>
      `,
    );
    expectResults(payload, [
      [
        "https://example.com",
        "Example & Co Café guide",
        "Fast search ... with café details",
        "example.com",
      ],
      ["https://example.org/direct", "Direct result", "Second snippet", "example.org"],
    ]);
    expect(JSON.stringify(payload.results)).not.toContain("Caf é");
  });

  it("rejects bot challenge pages without flagging ordinary result snippets", async () => {
    await expect(
      runHtmlSearch(
        "duckduckgo bot challenge",
        '<form>Are you a human?<div class="g-recaptcha">captcha</div></form>',
      ),
    ).rejects.toThrow("DuckDuckGo returned a bot-detection challenge.");
    const payload = await runHtmlSearch(
      "duckduckgo ordinary challenge result",
      `
      <a class="result__a" href="https://example.com/challenge">Coding Challenge</a>
      <a class="result__snippet">A fun coding challenge for interview prep.</a>
    `,
    );
    expectResults(payload, [
      [
        "https://example.com/challenge",
        "Coding Challenge",
        "A fun coding challenge for interview prep.",
      ],
    ]);
  });

  it.each([0, 1])("honors current TTL (%s minutes)", async (cacheTtlMinutes) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    let requests = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      requests += 1;
      return htmlResponse(
        `<a class="result__a" href="https://example.com/${requests}">Result ${requests}</a>`,
      );
    });
    const search = async (ttl: number) => {
      const tool = createSearchTool({ tools: { web: { search: { cacheTtlMinutes: ttl } } } });
      return await tool.execute({ query: `DuckDuckGo current TTL ${cacheTtlMinutes}` });
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
  });

  it("uses an honest User-Agent and returns the first two valid results with their snippets", async () => {
    const fetch = mockHtml(`
          <a class="result__a" href="https://example.com/empty-title"></a>
          <a class="result__snippet">Discarded empty-title snippet</a>
          <a class="result__a" href="https://example.com/first">First</a>
          <a class="result__snippet">First snippet</a>
          <a class="result__a" href="">Missing URL</a>
          <a class="result__snippet">Discarded missing-URL snippet</a>
          <a class="result__a" href="https://example.com/second">Second</a>
          <a class="result__a" href="https://example.com/third">Third</a>
          <a class="result__snippet">Third snippet</a>
    `);
    const tool = createSearchTool({ tools: { web: { search: { cacheTtlMinutes: 0 } } } });
    const result = await tool.execute({ query: "DuckDuckGo valid result count", count: 2 });
    expect(fetch).toHaveBeenCalledOnce();
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    const userAgent = headers.get("User-Agent");
    expect(userAgent).toMatch(/^openclaw-duckduckgo\//);
    expect(userAgent).not.toMatch(/Mozilla|Chrome|AppleWebKit/);
    const expected = [
      { url: "https://example.com/first", snippet: expect.stringContaining("First snippet") },
      { url: "https://example.com/second", snippet: "" },
    ];
    expect(result).toMatchObject({ count: expected.length, results: expected });
    expect(JSON.stringify(result)).not.toContain("Discarded");
  });
});
