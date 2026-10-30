import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import type { MockInstance } from "vitest";
import { afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { hangingFetchUntilAbort } from "../../test-support/hanging-fetch.test-support.js";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";
import { createDuckDuckGoWebSearchProvider } from "../web-search-contract-api.js";
import { runDuckDuckGoSearch } from "./ddg-client.js";

let fetch: MockInstance<typeof globalThis.fetch>;
beforeAll(async () => {
  await import("../index.js");
});
beforeEach(() => {
  fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected search"));
});
afterEach(() => vi.restoreAllMocks());

function createSearchTool(config: OpenClawConfig = {}, searchConfig?: SearchConfigRecord) {
  const tool = createDuckDuckGoWebSearchProvider().createTool({ config, searchConfig });
  assert(tool, "Expected tool definition");
  return tool;
}

function pluginConfig(webSearch: { region?: string; safeSearch?: string }) {
  return { plugins: { entries: { duckduckgo: { config: { webSearch } } } } };
}

function htmlResponse(html: string) {
  return new Response(html, { headers: { "content-type": "text/html" } });
}

function resultHtml(url: string, title: string, snippet = "") {
  return `<a class="result__a" href="${url}">${title}</a><a class="result__snippet">${snippet}</a>`;
}

async function search(query: string, html?: string) {
  if (html !== undefined) {
    fetch.mockResolvedValue(htmlResponse(html));
  }
  return await runDuckDuckGoSearch({ query });
}

it.each([4.5, 11])("rejects invalid count %s before searching", async (count) => {
  const tool = createSearchTool();
  await expect(tool.execute({ query: "openclaw docs", count })).rejects.toThrow(
    "count must be an integer from 1 to 10.",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects an already canceled search without fetching", async () => {
  const tool = createSearchTool();
  const signal = AbortSignal.abort(new Error("DuckDuckGo caller canceled"));
  await expect(tool.execute({ query: "pre-canceled" }, { signal })).rejects.toThrow(
    "DuckDuckGo caller canceled",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("aborts an in-flight DuckDuckGo request without caching its result", async () => {
  fetch.mockImplementation(async (_url, init) => {
    assert(init?.signal, "DuckDuckGo request lost caller cancellation");
    return await hangingFetchUntilAbort(_url, init);
  });
  const controller = new AbortController();
  const tool = createSearchTool();
  const query = "duckduckgo in-flight cancellation";
  const result = tool.execute({ query }, { signal: controller.signal });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  controller.abort(new Error("DuckDuckGo request canceled in flight"));
  await expect(result).rejects.toThrow("DuckDuckGo request canceled in flight");
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  fetch.mockResolvedValueOnce(htmlResponse(resultHtml("https://example.com", "Example")));
  await tool.execute({ query });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("preserves HTTP status for search failure guidance", async () => {
  fetch.mockResolvedValue(new Response("rate limited", { status: 429 }));
  await expect(search("rate limited")).rejects.toMatchObject({
    status: 429,
    statusCode: 429,
    message: "DuckDuckGo search error (429): rate limited",
  });
});

it("bounds successful DuckDuckGo HTML bodies without using response.text()", async () => {
  const streamed = createStreamingResponse({
    chunkCount: 32,
    chunkSize: 1024 * 1024,
    headers: { "Content-Type": "text/html" },
  });
  const textSpy = vi.spyOn(streamed.response, "text").mockRejectedValue(new Error("unbounded"));
  fetch.mockResolvedValue(streamed.response);
  await expect(search("bounded response")).rejects.toThrow(
    "DuckDuckGo search: text response exceeds 16777216 bytes",
  );
  expect(streamed.getReadCount()).toBeLessThan(32);
  expect(streamed.wasCanceled()).toBe(true);
  expect(textSpy).not.toHaveBeenCalled();
});

it.each([
  [{ region: "de-de" }, "de-de", "-1"],
  [{ region: "   " }, null, "-1"],
  [{}, null, "-1"],
  [{ safeSearch: "strict" }, null, "1"],
  [{ safeSearch: "off" }, null, "-2"],
] as const)("sends plugin config %j in the search request", async (options, region, safeSearch) => {
  fetch.mockResolvedValue(htmlResponse(""));
  await createSearchTool(pluginConfig(options)).execute({
    query: `DuckDuckGo ${JSON.stringify(options)}`,
  });
  expect(fetch).toHaveBeenCalledOnce();
  const request = fetch.mock.calls[0]?.[0];
  assert(typeof request === "string", "Expected DuckDuckGo request URL");
  const url = new URL(request);
  expect([url.searchParams.get("kl"), url.searchParams.get("kp")]).toEqual([region, safeSearch]);
});

it("parses href-first links and highlights without mistaking snippets for a challenge", async () => {
  const html = `<a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com" class="result__a">&#38; Caf<b>é</b></a>
    <a class="result__snippet">Fast&nbsp;&hellip; caf<b>é</b></a>
    ${resultHtml("https://example.org/direct", "Coding Challenge", "A coding challenge.")}`;
  const payload = await search("href ordering", html);
  expect(payload.results).toMatchObject([
    {
      url: "https://example.com",
      title: expect.stringContaining("& Café"),
      snippet: expect.stringContaining("Fast ... café"),
      siteName: "example.com",
    },
    {
      url: "https://example.org/direct",
      title: expect.stringContaining("Coding Challenge"),
      snippet: expect.stringContaining("A coding challenge."),
      siteName: "example.org",
    },
  ]);
  expect(JSON.stringify(payload.results)).not.toContain("Caf é");
});

it("rejects bot challenge pages", async () => {
  const challenge = '<form>Are you a human?<div class="g-recaptcha">captcha</div></form>';
  await expect(search("bot challenge", challenge)).rejects.toThrow(
    "DuckDuckGo returned a bot-detection challenge.",
  );
});

it.each([0, 1])("honors current TTL (%s minutes)", async (cacheTtlMinutes) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  let requests = 0;
  fetch.mockImplementation(async () => {
    requests += 1;
    return htmlResponse(resultHtml(`https://example.com/${requests}`, `Result ${requests}`));
  });
  const cachedSearch = async (ttl: number) => {
    const tool = createSearchTool({ tools: { web: { search: { cacheTtlMinutes: ttl } } } });
    return await tool.execute({ query: `DuckDuckGo current TTL ${cacheTtlMinutes}` });
  };
  const original = await cachedSearch(15);
  expect(await cachedSearch(15)).toEqual({ ...original, cached: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  if (cacheTtlMinutes > 0) {
    clock.mockReturnValue(Date.now() + 60_000);
  }
  const fresh = await cachedSearch(cacheTtlMinutes);
  expect(fresh.cached).toBeUndefined();
  expect(fresh.results).toEqual([expect.objectContaining({ url: "https://example.com/2" })]);
  expect(fetch).toHaveBeenCalledTimes(2);
  if (cacheTtlMinutes === 0) {
    const next = await cachedSearch(0);
    expect(next.cached).toBeUndefined();
    expect(next.results).toEqual([expect.objectContaining({ url: "https://example.com/3" })]);
    expect(await cachedSearch(15)).toEqual({ ...original, cached: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  } else {
    expect(await cachedSearch(1)).toEqual({ ...fresh, cached: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  }
});

it("uses an honest User-Agent and returns the first two valid results with their snippets", async () => {
  const html = [
    resultHtml("https://example.com/empty-title", "", "Discarded empty-title snippet"),
    resultHtml("https://example.com/first", "First", "First snippet"),
    resultHtml("", "Missing URL", "Discarded missing-URL snippet"),
    '<a class="result__a" href="https://example.com/second">Second</a>',
    resultHtml("https://example.com/third", "Third", "Third snippet"),
  ].join("");
  fetch.mockResolvedValue(htmlResponse(html));
  const tool = createSearchTool({ tools: { web: { search: { cacheTtlMinutes: 0 } } } });
  const result = await tool.execute({ query: "DuckDuckGo valid result count", count: 2 });
  expect(fetch).toHaveBeenCalledOnce();
  const userAgent = new Headers(fetch.mock.calls[0]?.[1]?.headers).get("User-Agent");
  expect(userAgent).toMatch(/^openclaw-duckduckgo\//);
  expect(userAgent).not.toMatch(/Mozilla|Chrome|AppleWebKit/);
  const expected = [
    { url: "https://example.com/first", snippet: expect.stringContaining("First snippet") },
    { url: "https://example.com/second", snippet: "" },
  ];
  expect(result).toMatchObject({ count: expected.length, results: expected });
  expect(JSON.stringify(result)).not.toContain("Discarded");
});

it.each([
  { label: "configured maxResults", maxResults: 2, count: undefined },
  { label: "explicit count over maxResults", maxResults: 1, count: 2 },
])("honors $label", async ({ maxResults, count }) => {
  fetch.mockResolvedValue(
    htmlResponse(
      [1, 2, 3].map((i) => resultHtml(`https://example.com/${i}`, `Result ${i}`)).join(""),
    ),
  );
  const tool = createSearchTool(
    { tools: { web: { search: { cacheTtlMinutes: 0 } } } },
    { maxResults, timeoutSeconds: 2 },
  );
  const result = await tool.execute({ query: "openclaw docs", count });
  expect(result.results).toHaveLength(2);
});

it.each([
  { label: "configured", searchConfig: { timeoutSeconds: 1 }, deadline: 1_000 },
  { label: "fallback", searchConfig: undefined, deadline: 20_000 },
])("cancels a slow search at the $label deadline", async ({ searchConfig, deadline }) => {
  vi.useFakeTimers();
  try {
    fetch.mockImplementation(hangingFetchUntilAbort);
    const tool = createSearchTool({}, searchConfig);
    const pending = expect(tool.execute({ query: `${deadline} deadline` })).rejects.toThrow(
      /timed out|TimeoutError|aborted/i,
    );
    await vi.advanceTimersByTimeAsync(deadline);
    await pending;
  } finally {
    vi.useRealTimers();
  }
});
