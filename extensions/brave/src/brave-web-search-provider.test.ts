import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBraveWebSearchProvider as createBraveWebSearchContractProvider } from "../web-search-contract-api.js";
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

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => logger,
}));

const braveManifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as {
  configSchema?: Record<string, unknown>;
};

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

function createBodyOnlyErrorResponse(params: { body: string; status: number }): Response {
  const bytes = new TextEncoder().encode(params.body);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: false,
    status: params.status,
    statusText: "Too Many Requests",
    headers: new Headers(),
    body,
  } as Response;
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
    mockFetch.mockReset().mockImplementation(async () => Response.json({ web: { results: [] } }));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    loggerInfoMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("points provider metadata at the canonical Brave docs page", () => {
    expect(createBraveWebSearchProvider().docsUrl).toBe(
      "https://docs.openclaw.ai/tools/brave-search",
    );
    expect(createBraveWebSearchContractProvider().docsUrl).toBe(
      "https://docs.openclaw.ai/tools/brave-search",
    );
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

  it("does not start an already canceled search", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Brave caller canceled"));
    await expect(
      createBraveTool().execute({ query: "brave pre-canceled" }, { signal: controller.signal }),
    ).rejects.toThrow("Brave caller canceled");
    expect(mockFetch).not.toHaveBeenCalled();
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

  it.each(["web", "llm-context"] as const)(
    "does not cache a %s response completed after caller cancellation",
    async (mode) => {
      const controller = new AbortController();
      const reason = new Error(`Brave ${mode} canceled after response`);
      const payload =
        mode === "web" ? { web: { results: [] } } : { grounding: { generic: [] }, sources: [] };
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
    },
  );

  it.each([
    [
      { search_lang: "en-US", ui_lang: "ja" },
      { search_lang: "jp", ui_lang: "en-US" },
    ],
    [
      { search_lang: "EN", ui_lang: "en-us" },
      { search_lang: "en", ui_lang: "en-US" },
    ],
    [{ search_lang: "xx" }, { error: "invalid_search_lang" }],
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

  it.each([{ baseUrl: "https://api.search.brave.com/proxy" }, { mode: "llm-context" }])(
    "accepts supported Brave plugin config fields: %#",
    (webSearch) => {
      if (!braveManifest.configSchema) {
        throw new Error("Expected Brave manifest config schema");
      }
      const result = validateJsonSchemaValue({
        schema: braveManifest.configSchema,
        cacheKey: "test:brave-config-schema-base-url",
        value: { webSearch },
      });
      expect(result.ok).toBe(true);
    },
  );

  it.each([
    ["web", "/", "web/search?q=latest+ai+news&count=5"],
    ["llm-context", "", "llm/context?q=latest+ai+news"],
  ])("uses configured Brave baseUrl for %s requests", async (mode, trailingSlash, suffix) => {
    if (mode === "llm-context") {
      mockFetch.mockImplementation(async () =>
        Response.json({ grounding: { generic: [] }, sources: [] }),
      );
    }
    const tool = createBraveTool({
      mode,
      baseUrl: `https://api.search.brave.com/proxy${trailingSlash}`,
    });
    await tool.execute({ query: "latest ai news" });
    expect(fetchRequestUrl().toString()).toBe(
      `https://api.search.brave.com/proxy/res/v1/${suffix}`,
    );
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

  describe.each([
    ["web", "Brave Search API error"],
    ["llm-context", "Brave LLM Context API error"],
  ])("%s provider errors", (mode, errorLabel) => {
    it("reports malformed JSON", async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response("{ nope", {
            headers: { "content-type": "application/json" },
          }),
      );
      await expect(createBraveTool({ mode }).execute({ query: "malformed JSON" })).rejects.toThrow(
        `${errorLabel}: malformed JSON response`,
      );
    });

    it("bounds error bodies without using response.text", async () => {
      mockFetch.mockImplementation(async () =>
        createBodyOnlyErrorResponse({
          status: 429,
          body: `${"x".repeat(24 * 1024)}tail-marker`,
        }),
      );
      const error = await createBraveTool({ mode })
        .execute({ query: "bounded error body" })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(`${errorLabel} (429):`);
      expect(message).not.toContain("tail-marker");
      expect(message.length).toBeLessThan(700);
    });
  });

  it("keeps Brave cache entries isolated by baseUrl", async () => {
    const firstTool = createBraveTool({ baseUrl: "https://api.search.brave.com/proxy-one" });
    const secondTool = createBraveTool({ baseUrl: "https://api.search.brave.com/proxy-two" });

    await firstTool.execute({ query: "base url cache identity" });
    await secondTool.execute({ query: "base url cache identity" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(fetchRequestUrl().pathname).toBe("/proxy-one/res/v1/web/search");
    expect(fetchRequestUrl(1).pathname).toBe("/proxy-two/res/v1/web/search");
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

  it("rejects invalid Brave mode values in the plugin config schema", () => {
    if (!braveManifest.configSchema) {
      throw new Error("Expected Brave manifest config schema");
    }

    const result = validateJsonSchemaValue({
      schema: braveManifest.configSchema,
      cacheKey: "test:brave-config-schema",
      value: {
        webSearch: {
          mode: "invalid-mode",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      {
        path: "webSearch.mode",
        message: 'must be equal to one of the allowed values (allowed: "web", "llm-context")',
        text: 'webSearch.mode: must be equal to one of the allowed values (allowed: "web", "llm-context")',
        allowedValues: ["web", "llm-context"],
        allowedValuesHiddenCount: 0,
      },
    ]);
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

  it.each(["web", "llm-context"])(
    "sends %s auth only in the X-Subscription-Token header",
    async (mode) => {
      if (mode === "llm-context") {
        mockFetch.mockImplementation(async () =>
          Response.json({ grounding: { generic: [] }, sources: [] }),
        );
      }
      await createBraveTool({ mode }).execute({ query: "auth header" });
      const requestUrl = fetchRequestUrl();
      expect(requestUrl.searchParams.get("apikey")).toBeNull();
      expect(requestUrl.searchParams.get("key")).toBeNull();
      expect(new Headers(fetchCall()[1]?.headers).get("X-Subscription-Token")).toBe(
        "brave-test-key",
      );
    },
  );

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
    ["", null],
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
