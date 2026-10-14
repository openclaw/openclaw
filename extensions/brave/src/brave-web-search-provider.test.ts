import type { LookupAddress } from "node:dns";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as undici from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const { loggerInfoMock, logger } = vi.hoisted(() => {
  const info = vi.fn();
  const subsystemLogger = {
    info,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    raw: vi.fn(),
    isEnabled: () => true,
    child: () => ({ ...subsystemLogger, child: vi.fn() }),
  };
  return { loggerInfoMock: info, logger: subsystemLogger };
});
const mockFetch = vi.fn<typeof fetch>();
const lookup = vi.hoisted(() => vi.fn<() => Promise<LookupAddress[]>>());
const publicAddress = [{ address: "93.184.216.34", family: 4 }];

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
  const config = { webSearch: { apiKey: "brave-test-key", ...webSearch } };
  const tool = createBraveWebSearchProvider().createTool({
    config: { ...context.config, plugins: { entries: { brave: { config } } } },
    searchConfig: context.searchConfig ?? {},
  });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return tool;
}

describe("brave web search provider", () => {
  beforeEach(() => {
    vi.stubEnv("BRAVE_API_KEY", "");
    lookup.mockReset().mockResolvedValue(publicAddress);
    mockFetch.mockReset().mockImplementation(async () => Response.json({ web: { results: [] } }));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    loggerInfoMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("points missing-key users to fetch/browser alternatives", async () => {
    const tool = createBraveTool({ apiKey: "" });

    const result = await tool.execute({ query: "OpenClaw docs" });

    expect(result).toEqual({
      error: "missing_brave_api_key",
      message:
        "web_search (brave) needs a Brave Search API key. Run `openclaw configure --section web` to store it, or set BRAVE_API_KEY in the Gateway environment. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("aborts an in-flight request with the caller's reason", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Brave request lost caller cancellation"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
          // Abort at transport entry so DNS preparation cannot race a polling deadline.
          controller.abort(new Error("Brave request canceled in flight"));
        }),
    );
    await expect(
      createBraveTool().execute(
        { query: "brave in-flight cancellation" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Brave request canceled in flight");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(fetchCall()[1]?.signal?.aborted).toBe(true);
  });

  it("does not cache a response completed after caller cancellation", async () => {
    const mode = "llm-context";
    const controller = new AbortController();
    const reason = new Error(`Brave ${mode} canceled after response`);
    const payload = { grounding: { generic: [] }, sources: [] };
    let firstRequest = true;
    mockFetch.mockImplementation(async () => {
      if (!firstRequest) {
        return Response.json(payload);
      }
      firstRequest = false;
      let emitted = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(stream) {
            if (!emitted) {
              emitted = true;
              stream.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
              return;
            }
            stream.close();
            controller.abort(reason);
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const tool = createBraveTool({ mode });
    const args = { query: `brave post-response cancellation ${mode}` };

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
  ])("normalizes language parameters through the public tool: %#", async (args, expected) => {
    const result = await createBraveTool().execute({
      query: "localized search",
      ...args,
    });
    if ("error" in expected) {
      expect(result).toMatchObject(expected);
      expect(mockFetch).not.toHaveBeenCalled();
      return;
    }
    const requestUrl = fetchRequestUrl();
    expect(requestUrl.searchParams.get("search_lang")).toBe(expected.search_lang);
    expect(requestUrl.searchParams.get("ui_lang")).toBe(expected.ui_lang);
  });

  it.each(["web", "llm-context"] as const)(
    "caps returned %s results and isolates cached responses by count",
    async (mode) => {
      const results = [
        { url: "https://example.com/first", title: "First", description: "first" },
        { url: "https://example.com/second", title: "Second", description: "second" },
        { url: "https://example.com/third", title: "Third", description: "third" },
      ];
      mockFetch.mockImplementation(async () =>
        Response.json(
          mode === "web"
            ? { web: { results } }
            : {
                grounding: {
                  generic: results.map(({ url, title, description }) => ({
                    url,
                    title,
                    snippets: [description],
                  })),
                },
              },
        ),
      );
      const tool = createBraveTool({ mode });
      const args = { query: `brave result count owner ${mode}`, count: 1 };

      const first = await tool.execute(args);
      const cached = await tool.execute(args);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(fetchRequestUrl().searchParams.get("count")).toBe(mode === "web" ? "1" : null);
      expect(fetchRequestUrl().searchParams.get("apikey")).toBeNull();
      expect(fetchRequestUrl().searchParams.get("key")).toBeNull();
      expect(new Headers(fetchCall()[1]?.headers).get("X-Subscription-Token")).toBe(
        "brave-test-key",
      );
      expect(first).toMatchObject({
        provider: "brave",
        count: 1,
        results: [{ url: "https://example.com/first" }],
      });
      expect(first.results).toHaveLength(1);
      expect(cached).toEqual({ ...first, cached: true });

      const larger = await tool.execute({ ...args, count: 2 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(larger).toMatchObject({
        count: 2,
        results: [{ url: "https://example.com/first" }, { url: "https://example.com/second" }],
      });
      expect(larger.results).toHaveLength(2);
      expect(await tool.execute({ ...args, count: 2 })).toEqual({ ...larger, cached: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    },
  );

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
    const args = { query: `brave cache TTL ${mode} ${cacheTtlMinutes}` };

    try {
      const original = await cachedTool.execute(args);
      expect(original).toMatchObject({ results: [{ url: "https://example.com/result-1" }] });
      expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(now + 60_000);
      const fresh = await currentTool.execute(args);
      expect(fresh).toMatchObject({ results: [{ url: "https://example.com/result-2" }] });
      expect(fresh).not.toHaveProperty("cached");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      if (cacheTtlMinutes === 0) {
        expect(await currentTool.execute(args)).toMatchObject({
          results: [{ url: "https://example.com/result-3" }],
        });
        expect(await cachedTool.execute(args)).toEqual({ ...original, cached: true });
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } else {
        expect(await currentTool.execute(args)).toEqual({ ...fresh, cached: true });
        expect(mockFetch).toHaveBeenCalledTimes(2);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("returns validation errors for invalid date ranges", async () => {
    const tool = createBraveTool();

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-03-20",
      date_before: "2026-03-01",
    });

    expect(result).toEqual({
      error: "invalid_date_range",
      message: "date_after must be before date_before.",
      docs: "https://docs.openclaw.ai/tools/web",
    });
  });

  it("preserves Brave publication timestamps without promoting relative age or crawl time", async () => {
    mockFetch.mockImplementation(async () =>
      Response.json({
        web: {
          results: [
            {
              title: "Dated",
              url: "https://example.com/dated",
              age: "2 days ago",
              page_age: "2025-04-12T14:22:41",
            },
            {
              title: "Undated",
              url: "https://example.com/undated",
              age: "2 days ago",
              page_fetched: "2025-04-14T14:22:41",
            },
          ],
        },
      }),
    );
    const tool = createBraveTool();

    const result = await tool.execute({ query: "publication metadata" });

    expect((result.results as Array<Record<string, unknown>>).map((row) => row.published)).toEqual([
      "2025-04-12T14:22:41",
      undefined,
    ]);
  });

  it("joins LLM-context publication dates by source URL, preserving unknown dates", async () => {
    const urls = [
      "https://example.com/timestamp",
      "https://example.com/day",
      "https://example.com/unknown",
    ] as const;
    mockFetch.mockImplementation(async () =>
      Response.json({
        grounding: {
          generic: urls.map((url) => ({ url, title: "Source", snippets: ["text", ""] })),
        },
        sources: {
          [urls[1]]: { age: ["Monday, January 15, 2024", "2024-01-15", "380 days ago"] },
          [urls[0]]: {
            age: ["Monday, January 15, 2024", "2024-01-15", "380 days ago", "2024-01-15T13:45:02Z"],
          },
          [urls[2]]: { age: [] },
        },
      }),
    );
    const tool = createBraveTool({ mode: "llm-context" });

    const result = await tool.execute({ query: "context publication metadata" });

    expect((result.results as Array<Record<string, unknown>>).map((row) => row.published)).toEqual([
      "2024-01-15T13:45:02Z",
      "2024-01-15",
      undefined,
    ]);
    expect((result.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      snippets: [expect.stringContaining("text")],
      siteName: "example.com",
      title: expect.stringContaining("Source"),
    });
  });

  it.each([
    { args: { freshness: "week" }, expected: "pw" },
    {
      args: { date_after: "2025-01-01", date_before: "2025-01-31" },
      expected: "2025-01-01to2025-01-31",
    },
    { args: { date_after: "2025-01-01" }, expected: undefined },
  ])("passes LLM-context time filters: $args", async ({ args, expected }) => {
    mockFetch.mockImplementation(async () =>
      Response.json({ grounding: { generic: [] }, sources: [] }),
    );
    await createBraveTool({ mode: "llm-context" }).execute({
      query: "time filter",
      ...args,
    });
    const today = new Date().toISOString().slice(0, 10);
    const requestUrl = fetchRequestUrl();
    expect(requestUrl.pathname).toBe("/res/v1/llm/context");
    expect(requestUrl.searchParams.get("freshness")).toBe(expected ?? `2025-01-01to${today}`);
  });

  it.each([
    {
      args: { date_after: "2999-01-01" },
      error: "invalid_date_range",
      message: "date_after cannot be in the future for Brave llm-context mode.",
    },
    {
      args: { date_before: "2025-01-31" },
      error: "unsupported_date_filter",
      message:
        "Brave llm-context mode requires date_after when date_before is set. Use a bounded date range or freshness.",
    },
  ])(
    "rejects invalid LLM-context time filters before fetch: $args",
    async ({ args, error, message }) => {
      const result = await createBraveTool({ mode: "llm-context" }).execute({
        query: "invalid filter",
        ...args,
      });
      expect(result).toEqual({ error, message, docs: "https://docs.openclaw.ai/tools/web" });
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["de", "DE"],
    [" VN ", "ALL"],
  ])("normalizes country %j through the public tool", async (country, expected) => {
    const tool = createBraveTool();

    await tool.execute({ query: "localized news", country });

    const requestUrl = fetchRequestUrl();
    expect(requestUrl.searchParams.get("country")).toBe(expected);
  });

  it("emits brave.http diagnostics for requests, responses, and cache events", async () => {
    const tool = createBraveTool({}, { config: { diagnostics: { flags: ["brave.http"] } } });

    await tool.execute({ query: "unique brave diagnostics query", count: 1 });
    await tool.execute({ query: "unique brave diagnostics query", count: 1 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const messages = loggerInfoMock.mock.calls.map((call) => call[0]);
    expect(messages).toEqual([
      "brave http cache miss",
      "brave http request",
      "brave http response",
      "brave http cache write",
      "brave http cache hit",
    ]);
    const requestLog = loggerInfoMock.mock.calls.find(
      ([message]) => message === "brave http request",
    );
    expect(requestLog?.[1]).toEqual({
      mode: "web",
      query: "unique brave diagnostics query",
      params: {
        count: "1",
        q: "unique brave diagnostics query",
      },
      url: "https://api.search.brave.com/res/v1/web/search?q=unique+brave+diagnostics+query&count=1",
    });
    const responseLog = loggerInfoMock.mock.calls.find(
      ([message]) => message === "brave http response",
    );
    const responsePayload = responseLog?.[1] as
      | { durationMs?: unknown; mode?: unknown; ok?: unknown; status?: unknown }
      | undefined;
    expect(responsePayload?.mode).toBe("web");
    expect(responsePayload?.status).toBe(200);
    expect(responsePayload?.ok).toBe(true);
    expect(typeof responsePayload?.durationMs).toBe("number");
    expect(responsePayload?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain("brave-test-key");
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain("X-Subscription-Token");
  });
});

describe("Brave preflight lifetime", () => {
  const privateAddress = [{ address: "10.20.30.40", family: 4 }];
  const payload = { web: { results: [] }, grounding: { generic: [] }, sources: [] };
  const fetchNetwork = vi.fn<typeof fetch>();
  let queryId = 0;

  function createTool(baseUrl: string) {
    return createBraveTool(
      { mode: "llm-context", baseUrl },
      { searchConfig: { timeoutSeconds: 1 } },
    );
  }

  function holdDns() {
    const dns = createDeferred<LookupAddress[]>();
    const entered = createDeferred<void>();
    lookup.mockImplementationOnce(() => {
      entered.resolve();
      return dns.promise;
    });
    return { dns, entered };
  }

  function observe<T>(promise: Promise<T>) {
    let outcome: { value: T } | { error: unknown } | undefined;
    const settled = promise.then(
      (value) => {
        outcome = { value };
      },
      (error: unknown) => {
        outcome = { error };
      },
    );
    return { settled, outcome: () => outcome };
  }

  beforeEach(() => {
    lookup.mockReset().mockResolvedValue(publicAddress);
    fetchNetwork.mockReset().mockImplementation(async (_input, init) => {
      init?.signal?.throwIfAborted();
      return Response.json(payload);
    });
    // A plain fetch adapter keeps the guard's real DNS/pinning path active. Only
    // the final network call is replaced; real dispatchers are created and released.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      fetchNetwork(input, init),
    );
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: fetchNetwork });
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "OPENCLAW_PROXY_ACTIVE",
      "OPENCLAW_DEBUG_PROXY_ENABLED",
    ]) {
      vi.stubEnv(key, "");
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["http", "https"] as const)(
    "rejects cancellation during the %s DNS-to-validator handoff before a cache hit",
    async (protocol) => {
      lookup.mockResolvedValue(privateAddress);
      const tool = createTool(`${protocol}://search.example.test`);
      const args = { query: `handoff-${++queryId}` };
      await tool.execute(args);
      fetchNetwork.mockClear();
      const { dns, entered } = holdDns();
      const caller = new AbortController();
      const reason = new Error("canceled after DNS settled");
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
        // Cancel on DNS settlement, before the request's async continuation can publish a result.
        void dns.promise.then(() => caller.abort(reason));
        dns.resolve(privateAddress);
        await operation.settled;
        expect(operation.outcome()).toEqual({ error: reason });
        expect(fetchNetwork).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        caller.abort(reason);
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each([
    { protocol: "http", stop: "cancel", warmCache: false },
    { protocol: "https", stop: "cancel", warmCache: false },
    { protocol: "http", stop: "deadline", warmCache: true },
    { protocol: "https", stop: "deadline", warmCache: true },
  ])(
    "rejects $stop during held $protocol DNS (warm cache: $warmCache)",
    async ({ protocol, stop, warmCache }) => {
      lookup.mockResolvedValue(privateAddress);
      const tool = createTool(`${protocol}://search.example.test`);
      const args = { query: `preflight-${++queryId}` };
      if (warmCache) {
        await expect(tool.execute(args)).resolves.toMatchObject({ provider: "brave" });
        await expect(tool.execute(args)).resolves.toMatchObject({ cached: true });
        expect(fetchNetwork).toHaveBeenCalledOnce();
        fetchNetwork.mockClear();
      }
      const { dns, entered } = holdDns();
      const caller = new AbortController();
      const reason = new Error("caller stopped during DNS");
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
        if (stop === "cancel") {
          caller.abort(reason);
        }
        await vi.advanceTimersByTimeAsync(stop === "deadline" ? 1_000 : 0);
        expect(operation.outcome()).toEqual({
          error: stop === "cancel" ? reason : expect.objectContaining({ name: "TimeoutError" }),
        });
        expect(fetchNetwork).not.toHaveBeenCalled();
        dns.resolve(privateAddress);
        await operation.settled;
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchNetwork).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await expect(tool.execute(args)).resolves.toMatchObject(
          warmCache ? { cached: true } : { provider: "brave" },
        );
        expect(fetchNetwork).toHaveBeenCalledTimes(warmCache ? 0 : 1);
      } finally {
        caller.abort(reason);
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each(["fetch", "body"] as const)(
    "keeps the original budget through HTTPS %s consumption",
    async (phase) => {
      lookup.mockResolvedValue(privateAddress);
      const { dns, entered } = holdDns();
      const dispatched = createDeferred<void>();
      fetchNetwork.mockImplementationOnce(async (_input, init) => {
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
      const caller = new AbortController();
      const tool = createTool("https://search.example.test");
      const args = { query: `budget-${++queryId}` };
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
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
        await tool.execute(args);
        expect(fetchNetwork).toHaveBeenCalledTimes(2);
      } finally {
        caller.abort();
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each<[string, string, LookupAddress[], boolean, boolean?]>([
    ["public HTTP", "http", publicAddress, false],
    ["rebound HTTPS", "https", privateAddress, false],
    ["fake IPv4", "https", [{ address: "198.18.0.1", family: 4 }], true],
    ["fake IPv6", "https", [{ address: "fc00::1", family: 6 }], true],
    ["redirect hostname", "https", publicAddress, false, true],
  ])("preserves endpoint policy: %s", async (_name, protocol, next, allowed, redirect) => {
    lookup.mockResolvedValueOnce(publicAddress).mockResolvedValue(next);
    if (redirect) {
      fetchNetwork.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
      );
    }
    const result = createTool(`${protocol}://search.example.test`).execute({
      query: `policy-${++queryId}`,
    });
    if (allowed) {
      await expect(result).resolves.toMatchObject({ provider: "brave" });
      expect(fetchNetwork).toHaveBeenCalledOnce();
      expect(lookup).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toThrow(redirect ? /allowlist/ : /private|loopback/);
      expect(fetchNetwork).toHaveBeenCalledTimes(redirect ? 1 : 0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
