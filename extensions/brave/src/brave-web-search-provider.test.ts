import type { LookupAddress } from "node:dns";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as undici from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

type Result = Record<string, unknown>;
const { loggerInfoMock } = vi.hoisted(() => ({ loggerInfoMock: vi.fn() }));
const mockFetch = vi.fn<typeof fetch>();
const lookup = vi.hoisted(() => vi.fn<() => Promise<LookupAddress[]>>());
const publicAddress = [{ address: "93.184.216.34", family: 4 }];
const contextPayload = { grounding: { generic: [] }, sources: [] };
const apiKey = "brave-test-key";
const cleanups: Array<() => Promise<void>> = [];

function respond(payload: unknown) {
  mockFetch.mockImplementation(async () => Response.json(payload));
}

function expectResults(result: Result, urls: string[]) {
  expect(result).toMatchObject({ provider: "brave", count: urls.length });
  expect(result.results).toEqual(urls.map((url) => expect.objectContaining({ url })));
}

async function expectCached(run: () => Promise<Result>, result: Result, calls: number) {
  expect(await run()).toEqual({ ...result, cached: true });
  expect(mockFetch).toHaveBeenCalledTimes(calls);
}

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

// mock-isolation: Capture diagnostics without creating process-global log sinks.
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({ info: loggerInfoMock }),
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

it.each([
  [{ apiKey: "" }, {}, "missing_brave_api_key"],
  [{}, { date_after: "2026-03-20", date_before: "2026-03-01" }, "invalid_date_range"],
  [{ mode: "llm-context" }, { date_after: "2999-01-01" }, "invalid_date_range"],
  [{ mode: "llm-context" }, { date_before: "2025-01-31" }, "unsupported_date_filter"],
  [{}, { search_lang: "en-US" }, "invalid_search_lang"],
  [{}, { ui_lang: "en" }, "invalid_ui_lang"],
] as const)("rejects invalid search: %j %j", async (config, args, error) => {
  const result = await createBraveTool(config).execute({ query: "invalid search", ...args });
  expect(result).toMatchObject({ error, docs: "https://docs.openclaw.ai/tools/web" });
  expect(mockFetch).not.toHaveBeenCalled();
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
  [{ country: "de" }, { country: "DE" }],
  [{ country: " VN " }, { country: "ALL" }],
])("normalizes locale parameters: %#", async (args, expected) => {
  await createBraveTool().execute({ query: "language", ...args });
  expect(Object.fromEntries(fetchRequestUrl().searchParams)).toMatchObject(expected);
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
    return Response.json(
      mode === "web" ? { web: { results: [result] } } : { grounding: { generic: [result] } },
    );
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

it.each(["web", "llm-context"] as const)("maps and caches %s", async (mode) => {
  const urls = [0, 1, 2, 3].map((i) => `https://example.com/${i}`);
  const timestamp = "2024-01-15T13:45:02Z";
  const day = "2024-01-15";
  const content = { title: "Source", description: "text", snippets: ["text", ""] };
  const results = urls.map((url, i) =>
    i > 1
      ? { url: mode === "web" ? undefined : url }
      : {
          url,
          ...content,
          page_age: i === 0 ? timestamp : undefined,
          page_fetched: timestamp,
          age: "380 days ago",
        },
  );
  const ages = [["Monday", day, "380 days ago", timestamp], ["Monday", day, "380 days ago"], []];
  respond(
    mode === "web"
      ? { web: { results } }
      : {
          grounding: { generic: results },
          sources: Object.fromEntries(urls.map((url, i) => [url, { age: ages[i] }])),
        },
  );
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
  expectResults(first, urls.slice(0, 1));
  const larger = await tool.execute({ ...args, count: 3 });
  expectResults(larger, mode === "web" ? [...urls.slice(0, 2), ""] : urls.slice(0, 3));
  const rows = larger.results as Result[];
  expect(rows.map((row) => row.published)).toEqual([
    timestamp,
    mode === "web" ? undefined : day,
    undefined,
  ]);
  if (mode === "llm-context") {
    expect(rows[0]).toMatchObject({
      snippets: [expect.stringContaining("text")],
      siteName: "example.com",
      title: expect.stringContaining("Source"),
    });
  }
  await expectCached(() => tool.execute({ ...args, count: 3 }), larger, 2);
});

it.each(["web", "llm-context"] as const)("keeps %s results credential-scoped", async (mode) => {
  const accounts = new Map([
    ["brave-account-a", "https://example.com/account-a"],
    ["brave-account-b", "https://example.com/account-b"],
  ]);
  mockFetch.mockImplementation(async (_url, init) => {
    const url = accounts.get(new Headers(init?.headers).get("X-Subscription-Token") ?? "");
    if (!url) {
      throw new Error("Unexpected synthetic Brave credential");
    }
    const results = [{ url, title: url }];
    return Response.json(
      mode === "web" ? { web: { results } } : { grounding: { generic: results } },
    );
  });
  const accountA = createBraveTool({ apiKey: "brave-account-a", mode });
  const accountB = createBraveTool({ apiKey: "brave-account-b", mode });
  const args = { query: `Brave credential-scoped results ${mode}` };

  const first = await accountA.execute(args);
  expectResults(first, ["https://example.com/account-a"]);
  expectResults(await accountB.execute(args), ["https://example.com/account-b"]);
  await expectCached(() => accountA.execute(args), first, 2);
});

it.each([
  [{ freshness: "week" }, "pw"],
  [{ date_after: "2025-01-01", date_before: "2025-01-31" }, "2025-01-01to2025-01-31"],
  [{ date_after: "2025-01-01" }, undefined],
] as const)("passes LLM-context time filters: %j", async (args, expected) => {
  respond(contextPayload);
  await createBraveTool({ mode: "llm-context" }).execute({ query: "time", ...args });
  const today = new Date().toISOString().slice(0, 10);
  const requestUrl = fetchRequestUrl();
  expect(requestUrl.pathname).toBe("/res/v1/llm/context");
  expect(requestUrl.searchParams.get("freshness")).toBe(expected ?? `2025-01-01to${today}`);
});

it("keeps Brave diagnostics free of queries and credentials", async () => {
  const tool = createBraveTool({}, { config: { diagnostics: { flags: ["brave.http"] } } });
  const query = "unique brave diagnostics query";
  await tool.execute({ query, count: 1 });
  await tool.execute({ query, count: 1 });
  const calls = loggerInfoMock.mock.calls;
  expect(loggerInfoMock).toHaveBeenCalledWith("brave http response", expect.any(Object));
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
    const observe = vi.fn<(result: { value: Result } | { error: unknown }) => void>();
    const settled = run(caller.signal).then(
      (value) => observe({ value }),
      (error: unknown) => observe({ error }),
    );
    cleanups.push(async () => {
      caller.abort(reason);
      dns.resolve(privateAddress);
      await settled;
    });
    await entered.promise;
    return { dns, caller, reason, settled, outcome: () => observe.mock.calls[0]?.[0] };
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
      await expectCached(run, first, 1);
      mockFetch.mockClear();
    }
    const { dns, caller, reason, ...operation } = await holdRequest(run);
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

  it.each([
    ["fetch", false],
    ["body", false],
    ["fetch", true],
  ] as const)("settles %s transport (caller cancellation: %s)", async (phase, cancel) => {
    const address = cancel ? publicAddress : privateAddress;
    lookup.mockResolvedValue(address);
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
    const { dns, caller, reason, ...operation } = await holdRequest(run);
    await vi.advanceTimersByTimeAsync(600);
    dns.resolve(address);
    await dispatched.promise;
    await vi.advanceTimersByTimeAsync(399);
    expect(operation.outcome()).toBeUndefined();
    if (cancel) {
      caller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(operation.outcome()).toEqual({
      error: cancel ? reason : expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(fetchCall()[1]?.signal?.aborted).toBe(true);
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
      expect(lookup).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toThrow(redirect ? /allowlist/ : /private|loopback/);
      expect(mockFetch).toHaveBeenCalledTimes(redirect ? 1 : 0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
