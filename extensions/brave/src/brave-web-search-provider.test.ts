import type { LookupAddress } from "node:dns";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import * as undici from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

type Result = Record<string, unknown>;
const { loggerInfoMock, logger } = vi.hoisted(() => {
  const info = vi.fn();
  const subsystemLogger: ReturnType<typeof createSubsystemLogger> = {
    subsystem: "brave",
    info,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    raw: vi.fn(),
    isEnabled: () => true,
    child: () => subsystemLogger,
  };
  return { loggerInfoMock: info, logger: subsystemLogger };
});
const mockFetch = vi.fn<typeof fetch>();
const lookup = vi.hoisted(() => vi.fn<() => Promise<LookupAddress[]>>());
const publicAddress = [{ address: "93.184.216.34", family: 4 }];
const contextPayload = { grounding: { generic: [] }, sources: [] };
const apiKey = "brave-test-key";
const cleanups: Array<() => Promise<void>> = [];

function respond(payload: unknown) {
  mockFetch.mockImplementation(async () => Response.json(payload));
}

function resultPayload(
  mode: string,
  results: Array<{ url: string; title?: string; description?: string }>,
) {
  const generic = results.map(({ description, ...row }) =>
    description === undefined ? row : { ...row, snippets: [description] },
  );
  return mode === "web" ? { web: { results } } : { grounding: { generic } };
}

function expectResults(result: Result, urls: string[]) {
  expect(result).toMatchObject({
    provider: "brave",
    count: urls.length,
    results: urls.map((url) => ({ url })),
  });
  expect(result.results).toHaveLength(urls.length);
}

async function expectCached(run: () => Promise<Result>, result: Result, calls: number) {
  expect(await run()).toEqual({ ...result, cached: true });
  expect(mockFetch).toHaveBeenCalledTimes(calls);
}

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => logger,
}));

afterAll(() => {
  vi.doUnmock("node:dns/promises");
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.resetModules();
});

beforeEach(() => {
  vi.stubEnv("BRAVE_API_KEY", "");
  lookup.mockReset().mockResolvedValue(publicAddress);
  mockFetch.mockReset();
  respond({ web: { results: [] } });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  loggerInfoMock.mockClear();
});

function fetchCall(index = 0) {
  const call = mockFetch.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call ${index + 1}`);
  }
  return call;
}

function fetchRequestUrl(index = 0) {
  const input = fetchCall(index)[0];
  return new URL(input instanceof Request ? input.url : input);
}

function createBraveTool(
  webSearch: Record<string, unknown> = {},
  context: Parameters<ReturnType<typeof createBraveWebSearchProvider>["createTool"]>[0] = {},
) {
  const config = { webSearch: { apiKey, ...webSearch } };
  const tool = createBraveWebSearchProvider().createTool({
    config: { ...context.config, plugins: { entries: { brave: { config } } } },
    searchConfig: context.searchConfig ?? {},
  });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return tool;
}

const missingKeyMessage =
  "web_search (brave) needs a Brave Search API key. Run `openclaw configure --section web` to store it, or set BRAVE_API_KEY in the Gateway environment. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.";
const reversedDatesMessage = "date_after must be before date_before.";
const futureDateMessage = "date_after cannot be in the future for Brave llm-context mode.";
const endOnlyMessage =
  "Brave llm-context mode requires date_after when date_before is set. Use a bounded date range or freshness.";
it.each([
  [{ apiKey: "" }, {}, "missing_brave_api_key", missingKeyMessage],
  [
    {},
    { date_after: "2026-03-20", date_before: "2026-03-01" },
    "invalid_date_range",
    reversedDatesMessage,
  ],
  [{ mode: "llm-context" }, { date_after: "2999-01-01" }, "invalid_date_range", futureDateMessage],
  [
    { mode: "llm-context" },
    { date_before: "2025-01-31" },
    "unsupported_date_filter",
    endOnlyMessage,
  ],
] as const)("rejects invalid search: %j %j", async (config, args, error, message) => {
  const result = await createBraveTool(config).execute({ query: "invalid search", ...args });
  expect(result).toEqual({ error, message, docs: "https://docs.openclaw.ai/tools/web" });
  expect(mockFetch).not.toHaveBeenCalled();
});

it("preserves in-flight cancellation reasons", async () => {
  const controller = new AbortController();
  mockFetch.mockImplementation(async (_url, init) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Brave request lost caller cancellation");
    }
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      // Abort at transport entry so DNS preparation cannot race a polling deadline.
      controller.abort(new Error("Brave request canceled in flight"));
    });
  });
  await expect(
    createBraveTool().execute({ query: "in-flight" }, { signal: controller.signal }),
  ).rejects.toThrow("Brave request canceled in flight");
  expect(mockFetch).toHaveBeenCalledOnce();
  expect(fetchCall()[1]?.signal?.aborted).toBe(true);
});

it("does not cache a canceled response", async () => {
  const controller = new AbortController();
  const reason = new Error("Brave llm-context canceled after response");
  respond(contextPayload);
  mockFetch.mockImplementationOnce(async () => {
    let emitted = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(stream) {
          if (!emitted) {
            emitted = true;
            stream.enqueue(new TextEncoder().encode(JSON.stringify(contextPayload)));
            return;
          }
          stream.close();
          controller.abort(reason);
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const tool = createBraveTool({ mode: "llm-context" });
  const args = { query: "post-response" };
  await expect(tool.execute(args, { signal: controller.signal })).rejects.toBe(reason);
  await tool.execute(args);
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it.each([
  [
    { search_lang: "en-US", ui_lang: "ja" },
    { search_lang: "jp", ui_lang: "en-US" },
  ],
  [{ search_lang: "en-US" }, { error: "invalid_search_lang" }],
  [{ ui_lang: "en" }, { error: "invalid_ui_lang" }],
  [{ country: "de" }, { country: "DE" }],
  [{ country: " VN " }, { country: "ALL" }],
])("normalizes locale parameters: %#", async (args, expected) => {
  const result = await createBraveTool().execute({ query: "language", ...args });
  if ("error" in expected) {
    expect(result).toMatchObject(expected);
    expect(mockFetch).not.toHaveBeenCalled();
    return;
  }
  const params = fetchRequestUrl().searchParams;
  expect(Object.fromEntries(params)).toMatchObject(expected);
});

it.each(["web", "llm-context"] as const)("caps %s results and separates caches", async (mode) => {
  const results = ["first", "second", "third"].map((name) => ({
    url: `https://example.com/${name}`,
    title: name,
    description: name,
  }));
  respond(resultPayload(mode, results));
  const tool = createBraveTool({ mode });
  const args = { query: `count-${mode}`, count: 1 };
  const first = await tool.execute(args);
  await expectCached(() => tool.execute(args), first, 1);
  const params = fetchRequestUrl().searchParams;
  expect([params.get("count"), params.get("apikey"), params.get("key")]).toEqual([
    mode === "web" ? "1" : null,
    null,
    null,
  ]);
  expect(new Headers(fetchCall()[1]?.headers).get("X-Subscription-Token")).toBe(apiKey);
  expectResults(first, ["https://example.com/first"]);
  const larger = await tool.execute({ ...args, count: 2 });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expectResults(larger, ["https://example.com/first", "https://example.com/second"]);
  await expectCached(() => tool.execute({ ...args, count: 2 }), larger, 2);
});

it.each([
  { mode: "web", cacheTtlMinutes: 0 },
  { mode: "llm-context", cacheTtlMinutes: 1 },
])("honors current $mode cache TTL $cacheTtlMinutes", async ({ mode, cacheTtlMinutes }) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let requestCount = 0;
  mockFetch.mockImplementation(async () => {
    const result = { url: `https://example.com/result-${++requestCount}` };
    return Response.json(resultPayload(mode, [result]));
  });
  const cachedTool = createBraveTool({ mode }, { searchConfig: { cacheTtlMinutes: 15 } });
  const currentTool = createBraveTool({ mode }, { searchConfig: { cacheTtlMinutes } });
  const args = { query: `ttl-${mode}` };
  const original = await cachedTool.execute(args);
  expect(original).toMatchObject({ results: [{ url: "https://example.com/result-1" }] });
  await expectCached(() => cachedTool.execute(args), original, 1);
  clock.mockReturnValue(now + 60_000);
  const fresh = await currentTool.execute(args);
  expect(fresh).toMatchObject({ results: [{ url: "https://example.com/result-2" }] });
  expect(fresh).not.toHaveProperty("cached");
  expect(mockFetch).toHaveBeenCalledTimes(2);
  if (cacheTtlMinutes === 0) {
    expect(await currentTool.execute(args)).toMatchObject({
      results: [{ url: "https://example.com/result-3" }],
    });
    await expectCached(() => cachedTool.execute(args), original, 3);
  } else {
    await expectCached(() => currentTool.execute(args), fresh, 2);
  }
});

it.each(["web", "llm-context"])("preserves %s publication dates, not ages", async (mode) => {
  const urls = {
    timestamp: "https://example.com/timestamp",
    day: "https://example.com/day",
    unknown: "https://example.com/unknown",
  };
  const age = ["Monday, January 15, 2024", "2024-01-15", "380 days ago"];
  if (mode === "web") {
    const results = [
      { page_age: "2025-04-12T14:22:41", age: "2 days ago" },
      { page_fetched: "2025-04-14T14:22:41", age: "2 days ago" },
    ];
    respond({ web: { results } });
  } else {
    const generic = Object.values(urls).map((url) => ({
      url,
      title: "Source",
      snippets: ["text", ""],
    }));
    respond({
      grounding: { generic },
      sources: {
        [urls.day]: { age },
        [urls.timestamp]: { age: [...age, "2024-01-15T13:45:02Z"] },
        [urls.unknown]: { age: [] },
      },
    });
  }
  const result = await createBraveTool({ mode }).execute({ query: `dates-${mode}` });
  const rows = result.results as Result[];
  expect(rows.map((row) => row.published)).toEqual(
    mode === "web"
      ? ["2025-04-12T14:22:41", undefined]
      : ["2024-01-15T13:45:02Z", "2024-01-15", undefined],
  );
  if (mode === "llm-context") {
    expect(rows[0]).toMatchObject({
      snippets: [expect.stringContaining("text")],
      siteName: "example.com",
      title: expect.stringContaining("Source"),
    });
  }
});

it.each([
  { args: { freshness: "week" }, expected: "pw" },
  {
    args: { date_after: "2025-01-01", date_before: "2025-01-31" },
    expected: "2025-01-01to2025-01-31",
  },
  { args: { date_after: "2025-01-01" }, expected: undefined },
])("passes LLM-context time filters: $args", async ({ args, expected }) => {
  respond(contextPayload);
  await createBraveTool({ mode: "llm-context" }).execute({ query: "time", ...args });
  const today = new Date().toISOString().slice(0, 10);
  const requestUrl = fetchRequestUrl();
  expect(requestUrl.pathname).toBe("/res/v1/llm/context");
  expect(requestUrl.searchParams.get("freshness")).toBe(expected ?? `2025-01-01to${today}`);
});

it("emits brave.http diagnostics for requests, responses, and cache events", async () => {
  const tool = createBraveTool({}, { config: { diagnostics: { flags: ["brave.http"] } } });
  const query = "unique brave diagnostics query";
  await tool.execute({ query, count: 1 });
  await tool.execute({ query, count: 1 });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const calls = loggerInfoMock.mock.calls;
  expect(calls.map((call) => call[0])).toEqual(
    ["cache miss", "request", "response", "cache write", "cache hit"].map(
      (event) => `brave http ${event}`,
    ),
  );
  expect(calls[1]?.[1]).toEqual({
    mode: "web",
    count: 1,
    endpoint: "https://api.search.brave.com/res/v1/web/search",
  });
  const responsePayload = calls[2]?.[1];
  expect(responsePayload).toMatchObject({
    mode: "web",
    status: 200,
    ok: true,
    durationMs: expect.any(Number),
  });
  expect(responsePayload?.durationMs).toBeGreaterThanOrEqual(0);
  for (const sensitive of [apiKey, "X-Subscription-Token", query]) {
    expect(JSON.stringify(calls)).not.toContain(sensitive);
  }
});
describe("Brave preflight lifetime", () => {
  const privateAddress = [{ address: "10.20.30.40", family: 4 }];
  let queryId = 0;
  function privateSearch(protocol = "https") {
    const tool = createBraveTool(
      { mode: "llm-context", baseUrl: `${protocol}://search.example.test` },
      { searchConfig: { timeoutSeconds: 1 } },
    );
    const args = { query: `preflight-${++queryId}` };
    return (signal?: AbortSignal) => tool.execute(args, { signal });
  }

  async function holdRequest(run: ReturnType<typeof privateSearch>) {
    const dns = createDeferred<LookupAddress[]>();
    const entered = createDeferred<void>();
    lookup.mockImplementationOnce(() => {
      entered.resolve();
      return dns.promise;
    });
    const caller = new AbortController();
    const reason = new Error("caller stopped during DNS");
    let outcome: { value: Result } | { error: unknown } | undefined;
    const settled = run(caller.signal).then(
      (value) => {
        outcome = { value };
      },
      (error: unknown) => {
        outcome = { error };
      },
    );
    cleanups.push(async () => {
      caller.abort(reason);
      dns.resolve(privateAddress);
      await settled;
    });
    await entered.promise;
    return { dns, caller, reason, operation: { settled, outcome: () => outcome } };
  }

  beforeEach(() => {
    mockFetch.mockImplementation(async (_input, init) => {
      init?.signal?.throwIfAborted();
      return Response.json({ web: { results: [] }, ...contextPayload });
    });
    // Keep real DNS/pinning and dispatcher lifecycle; replace only final network I/O.
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => mockFetch(...args));
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: mockFetch });
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  it.each([
    { protocol: "http", stop: "handoff", warmCache: true },
    { protocol: "https", stop: "handoff", warmCache: true },
    { protocol: "http", stop: "cancel", warmCache: false },
    { protocol: "https", stop: "cancel", warmCache: false },
    { protocol: "http", stop: "deadline", warmCache: true },
    { protocol: "https", stop: "deadline", warmCache: true },
  ])("rejects $protocol DNS $stop (cache: $warmCache)", async ({ protocol, stop, warmCache }) => {
    lookup.mockResolvedValue(privateAddress);
    const run = privateSearch(protocol);
    if (warmCache) {
      const first = await run();
      expect(first).toMatchObject({ provider: "brave" });
      await expectCached(run, first, 1);
      mockFetch.mockClear();
    }
    const { dns, caller, reason, operation } = await holdRequest(run);
    if (stop === "handoff") {
      // Abort between DNS settlement and the validator continuation, before a cache hit.
      void dns.promise.then(() => caller.abort(reason));
      dns.resolve(privateAddress);
      await operation.settled;
    } else if (stop === "cancel") {
      caller.abort(reason);
    }
    await vi.advanceTimersByTimeAsync(stop === "deadline" ? 1_000 : 0);
    expect(operation.outcome()).toEqual({
      error: stop === "deadline" ? expect.objectContaining({ name: "TimeoutError" }) : reason,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    dns.resolve(privateAddress);
    await operation.settled;
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (stop !== "handoff") {
      await expect(run()).resolves.toMatchObject(
        warmCache ? { cached: true } : { provider: "brave" },
      );
      expect(mockFetch).toHaveBeenCalledTimes(warmCache ? 0 : 1);
    }
  });

  it.each(["fetch", "body"] as const)("shares deadline across %s", async (phase) => {
    lookup.mockResolvedValue(privateAddress);
    const dispatched = createDeferred<void>();
    mockFetch.mockImplementationOnce(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing request signal");
      }
      signal.throwIfAborted();
      if (phase === "fetch") {
        return await new Promise<Response>((_resolve, reject) => {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Fetch preserves AbortSignal reasons, including non-Error values.
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          dispatched.resolve();
        });
      }
      return new Response(
        new ReadableStream({
          start(stream) {
            signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
            dispatched.resolve();
          },
        }),
      );
    });
    const run = privateSearch();
    const { dns, operation } = await holdRequest(run);
    await vi.advanceTimersByTimeAsync(600);
    dns.resolve(privateAddress);
    await dispatched.promise;
    await vi.advanceTimersByTimeAsync(399);
    expect(operation.outcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(operation.outcome()).toEqual({
      error: expect.objectContaining({ name: "TimeoutError" }),
    });
    await operation.settled;
    expect(vi.getTimerCount()).toBe(0);
    await run();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each<[string, string, LookupAddress[], boolean, boolean?]>([
    ["public HTTP", "http", publicAddress, false],
    ["rebound HTTPS", "https", privateAddress, false],
    ["fake IPv4", "https", [{ address: "198.18.0.1", family: 4 }], true],
    ["fake IPv6", "https", [{ address: "fc00::1", family: 6 }], true],
    ["redirect hostname", "https", publicAddress, false, true],
  ])("preserves endpoint policy: %s", async (_name, protocol, next, allowed, redirect) => {
    lookup.mockResolvedValueOnce(publicAddress).mockResolvedValue(next);
    if (redirect) {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
      );
    }
    const result = privateSearch(protocol)();
    if (allowed) {
      await expect(result).resolves.toMatchObject({ provider: "brave" });
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(lookup).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toThrow(redirect ? /allowlist/ : /private|loopback/);
      expect(mockFetch).toHaveBeenCalledTimes(redirect ? 1 : 0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
