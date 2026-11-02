// Google tests cover web search provider plugin behavior.
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

type TestModelProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function geminiAnswer(text: string, groundingMetadata: object = {}) {
  return { candidates: [{ content: { parts: [{ text }] }, groundingMetadata }] };
}
function candidateResponse(candidate: unknown) {
  return { candidates: [candidate] };
}
function installGeminiResponse(body: string, init?: ResponseInit) {
  const mockFetch = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(body, init)),
  );
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
  return mockFetch;
}
function installGeminiFetch(
  body: unknown = geminiAnswer("Grounded answer", {
    groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
  }),
  init?: ResponseInit,
) {
  return installGeminiResponse(JSON.stringify(body), init);
}
function postedCalls(mockFetch: ReturnType<typeof installGeminiFetch>) {
  return mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
}

function withGoogleModel(
  config: OpenClawConfig,
  overrides: Partial<TestModelProviderConfig>,
): OpenClawConfig {
  return {
    ...config,
    models: {
      providers: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
          models: [],
          ...overrides,
        },
      },
    },
  };
}

function getFetchHeaders(mockFetch: ReturnType<typeof installGeminiFetch>): Record<string, string> {
  return Object.fromEntries(new Headers(postedCalls(mockFetch)[0]?.[1]?.headers).entries());
}

function createGeminiToolOptions(webSearch: Record<string, unknown> = {}) {
  return {
    config: {
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: "AIza-plugin-test",
                ...webSearch,
              },
            },
          },
        },
      },
    },
    searchConfig: { provider: "gemini" },
  };
}

function createGeminiTool(
  webSearch: Record<string, unknown> = {},
  searchConfig: Record<string, unknown> = {},
) {
  const options = createGeminiToolOptions(webSearch);
  return createGeminiWebSearchProvider().createTool({
    ...options,
    searchConfig: { ...options.searchConfig, ...searchConfig },
  });
}
function createGeminiToolWithHeaders(headers: Record<string, unknown>) {
  return createGeminiTool({ headers });
}
function getGeminiFetchUrl(mockFetch: ReturnType<typeof installGeminiFetch>): string | undefined {
  const input = postedCalls(mockFetch)[0]?.[0];
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input?.url;
}

function parseGeminiFetchBody(
  mockFetch: ReturnType<typeof installGeminiFetch>,
  index = 0,
): {
  contents?: Array<{ parts?: Array<{ text?: string }> }>;
  tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
} {
  const body = postedCalls(mockFetch)[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected Gemini fetch body string");
  }
  return JSON.parse(body) as {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
    tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("google web search provider", () => {
  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync({ GEMINI_API_KEY: undefined }, async () => {
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }

      await expect(tool.execute({ query: "OpenClaw docs" })).resolves.toEqual({
        docs: "https://docs.openclaw.ai/tools/web",
        error: "missing_gemini_api_key",
        message:
          "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, configure plugins.entries.google.config.webSearch.apiKey, or reuse models.providers.google.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      });
    });
  });

  it("stores configured credentials at the canonical plugin config path", () => {
    const provider = createGeminiWebSearchProvider();
    const config = {} as OpenClawConfig;

    provider.setConfiguredCredentialValue?.(config, "AIza-plugin-test");

    expect(provider.credentialPath).toBe("plugins.entries.google.config.webSearch.apiKey");
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("AIza-plugin-test");
  });

  it.each([
    [undefined, "gemini-3.6-flash"],
    ["  ", "gemini-3.6-flash"],
    [" gemini-3.5-flash ", "gemini-3.5-flash"],
  ])("selects model %j as %s through plugin config", async (model, expectedModel) => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiTool({ model }, { cacheTtlMinutes: 0 });

    const result = await tool?.execute({ query: "OpenClaw model selection" });

    expect(getGeminiFetchUrl(mockFetch)).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${expectedModel}:generateContent`,
    );
    expect(result).toMatchObject({ provider: "gemini", model: expectedModel });
    expect(parseGeminiFetchBody(mockFetch).tools).toEqual([{ google_search: {} }]);
  });

  it("sends operator headers while keeping provider-owned headers authoritative", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({
      "X-Routing-Target": "staging",
      "X-Gateway-Token": "resolved-gateway-token",
      "X-Goog-Api-Key": "operator-value",
    });

    await tool?.execute({ query: "OpenClaw operator headers" });

    expect(getFetchHeaders(mockFetch)).toMatchObject({
      "content-type": "application/json",
      "x-gateway-token": "resolved-gateway-token",
      "x-goog-api-key": "AIza-plugin-test",
      "x-routing-target": "staging",
    });
  });

  it("partitions cached Gemini results by operator headers", async () => {
    const mockFetch = installGeminiFetch();

    await createGeminiToolWithHeaders({ "X-Routing-Target": "staging" })?.execute({
      query: "OpenClaw header cache partition",
    });
    await createGeminiToolWithHeaders({ "X-Routing-Target": "production" })?.execute({
      query: "OpenClaw header cache partition",
    });

    const postCalls = postedCalls(mockFetch);
    expect(postCalls).toHaveLength(2);
  });

  it("reuses cached Gemini answers across ignored result counts while rejecting invalid counts", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({});
    const query = "unique Gemini ignored result count cache regression";

    await tool?.execute({ query, count: 1 });
    await tool?.execute({ query, count: 10 });
    await tool?.execute({ query });

    await expect(tool?.execute({ query, count: 0 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    const postCalls = postedCalls(mockFetch);
    expect(postCalls).toHaveLength(1);
  });

  it.each([0, 1])("honors the current Gemini cache TTL of %s minutes", async (cacheTtlMinutes) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let content = "Original grounded answer";
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }] })),
    );
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
    const createTool = (ttl: number) => createGeminiTool({}, { cacheTtlMinutes: ttl });
    const query = `Gemini current request cache TTL ${cacheTtlMinutes}`;
    const cachedTool = createTool(15);
    await cachedTool?.execute({ query });
    await expect(cachedTool?.execute({ query })).resolves.toMatchObject({
      cached: true,
      content: expect.stringContaining("Original grounded answer"),
    });
    expect(mockFetch).toHaveBeenCalledOnce();

    now.mockReturnValue(1_060_000);
    content = "Fresh grounded answer";
    const currentTool = createTool(cacheTtlMinutes);
    const fresh = await currentTool?.execute({ query });
    expect(fresh).not.toHaveProperty("cached");
    expect(fresh).toMatchObject({ content: expect.stringContaining("Fresh grounded answer") });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    if (cacheTtlMinutes === 0) {
      await expect(currentTool?.execute({ query })).resolves.not.toHaveProperty("cached");
      expect(mockFetch).toHaveBeenCalledTimes(3);
      await expect(cachedTool?.execute({ query })).resolves.toMatchObject({
        cached: true,
        content: expect.stringContaining("Original grounded answer"),
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } else {
      await expect(currentTool?.execute({ query })).resolves.toEqual({ ...fresh, cached: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }
  });

  it("does not partition cached results by overwritten provider-owned headers", async () => {
    const mockFetch = installGeminiFetch();

    await createGeminiToolWithHeaders({ "X-Goog-Api-Key": "operator-one" })?.execute({
      query: "OpenClaw provider-owned header cache",
    });
    await createGeminiToolWithHeaders({ "x-goog-api-key": "operator-two" })?.execute({
      query: "OpenClaw provider-owned header cache",
    });

    const postCalls = postedCalls(mockFetch);
    expect(postCalls).toHaveLength(1);
    expect(getFetchHeaders(mockFetch)["x-goog-api-key"]).toBe("AIza-plugin-test");
  });

  it("normalizes case collisions before sending and partitioning the cache", async () => {
    const mockFetch = installGeminiFetch();

    await createGeminiToolWithHeaders({
      "X-Routing-Target": "stale",
      "x-routing-target": "production",
    })?.execute({ query: "OpenClaw case-colliding header cache" });
    await createGeminiToolWithHeaders({ "X-Routing-Target": "production" })?.execute({
      query: "OpenClaw case-colliding header cache",
    });

    const postCalls = postedCalls(mockFetch);
    expect(postCalls).toHaveLength(1);
    expect(getFetchHeaders(mockFetch)["x-routing-target"]).toBe("production");
  });

  it("preserves legal empty literal header values", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({ "X-Optional-Metadata": " \t " });

    await tool?.execute({ query: "OpenClaw empty operator header" });

    expect(getFetchHeaders(mockFetch)["x-optional-metadata"]).toBe("");
  });

  it("rejects malformed operator headers before sending a request", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({ "Bad Header": "value" });

    await expect(tool?.execute({ query: "OpenClaw malformed header" })).rejects.toThrow(
      'plugins.entries.google.config.webSearch.headers["Bad Header"] is not a valid HTTP header',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(["Connection", "Content-Length"])(
    "rejects reserved or framing operator header %s before fetch",
    async (name) => {
      const mockFetch = installGeminiFetch();
      const tool = createGeminiToolWithHeaders({ [name]: "configured-value" });

      await expect(tool?.execute({ query: `OpenClaw rejects ${name}` })).rejects.toThrow(
        `plugins.entries.google.config.webSearch.headers["${name}"] uses a reserved or framing HTTP header`,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("keeps unresolved explicit header SecretRefs strict", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiToolWithHeaders({
      "X-Gateway-Token": {
        source: "env",
        provider: "default",
        id: "GEMINI_GATEWAY_TOKEN",
      },
    });

    await expect(
      tool?.execute({ query: "OpenClaw unresolved header SecretRef" }),
    ).rejects.toMatchObject({
      name: "UnresolvedSecretInputError",
      path: 'plugins.entries.google.config.webSearch.headers["X-Gateway-Token"]',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("accepts Gemini success JSON with empty grounding metadata", async () => {
    installGeminiFetch(geminiAnswer("Today's date is Sunday, June 7, 2026."));
    const tool = createGeminiTool();

    const result = await tool?.execute({ query: "current date today" });

    expect(result).toMatchObject({
      citations: [],
      model: "gemini-3.6-flash",
      provider: "gemini",
      content: expect.stringContaining("Today's date is Sunday, June 7, 2026."),
    });
  });

  it.each([
    { httpStatus: 401, embedded: false },
    { httpStatus: 403, embedded: false },
    { httpStatus: 429, embedded: false },
    { httpStatus: 403, embedded: true },
  ])(
    "preserves typed status $httpStatus (embedded=$embedded)",
    async ({ httpStatus, embedded }) => {
      installGeminiFetch(
        { error: { code: httpStatus, message: "denied key=AIza-plugin-test" } },
        { status: embedded ? 200 : httpStatus },
      );
      const tool = createGeminiTool();
      await expect(
        tool?.execute({ query: `synthetic-http-${embedded}-${httpStatus}` }),
      ).rejects.toMatchObject({
        status: httpStatus,
        statusCode: httpStatus,
        message: expect.not.stringContaining("AIza-plugin-test"),
      });
    },
  );

  it.each([
    ["empty parts", candidateResponse({ content: { parts: [] }, finishReason: "STOP" }), " (STOP)"],
    [
      "missing parts",
      candidateResponse({ content: { role: "model" }, finishReason: "STOP" }),
      " (STOP)",
    ],
    ["missing content", candidateResponse({ finishReason: "STOP" }), " (STOP)"],
    [
      "nontext part",
      candidateResponse({ content: { parts: [{ functionCall: {} }] }, finishReason: "STOP" }),
      " (STOP)",
    ],
    ["empty candidates", { candidates: [] }, ""],
    ["missing candidates", {}, ""],
    ["blocked prompt", { promptFeedback: { blockReason: "SAFETY" } }, " (SAFETY)"],
    ["blank reason", candidateResponse({ finishReason: "  " }), ""],
  ])(
    "reports no final answer for %s without inventing search results",
    async (_name, body, reason) => {
      installGeminiFetch(body);
      const tool = createGeminiToolWithHeaders({});

      await expect(tool?.execute({ query: "OpenClaw empty answer" })).rejects.toThrow(
        `Gemini search returned no final answer${reason}.`,
      );
    },
  );

  it.each([
    ["JSON syntax", "{ nope"],
    ["array root", []],
    ["non-array candidates", { candidates: {} }],
    ["null candidate", candidateResponse(null)],
    ["non-record content", candidateResponse({ content: "invalid" })],
    ["null part", candidateResponse({ content: { parts: [null] } })],
    ["non-string part text", candidateResponse({ content: { parts: [{ text: 7 }] } })],
    ["non-array parts", candidateResponse({ content: { parts: {} } })],
    ["non-record prompt feedback", { promptFeedback: [] }],
    ["non-string block reason", { promptFeedback: { blockReason: {} } }],
    ["non-string finish reason", candidateResponse({ finishReason: 1 })],
    ["non-record grounding metadata", candidateResponse({ groundingMetadata: [] })],
    [
      "non-array grounding chunks",
      candidateResponse({ groundingMetadata: { groundingChunks: {} } }),
    ],
    ["non-record error", { error: "invalid" }],
  ])("keeps malformed %s distinct from an absent answer", async (_name, body) => {
    installGeminiResponse(typeof body === "string" ? body : JSON.stringify(body));
    const tool = createGeminiToolWithHeaders({});

    await expect(tool?.execute({ query: "OpenClaw malformed answer" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
    );
  });

  it("bounds the provider reason in an empty-answer diagnostic", async () => {
    installGeminiFetch({ candidates: [{ finishReason: "X".repeat(1_000) }] });
    const tool = createGeminiToolWithHeaders({});

    await expect(tool?.execute({ query: "OpenClaw bounded reason" })).rejects.toThrow(
      `Gemini search returned no final answer (${"X".repeat(119)}…).`,
    );
  });

  it("preserves text-bearing partial answers with malformed sibling parts", async () => {
    const parts = [null, { text: 7 }, { text: "Partial answer" }];
    installGeminiFetch({
      candidates: [{ content: { parts }, finishReason: "MAX_TOKENS" }],
    });
    const tool = createGeminiToolWithHeaders({});

    await expect(
      tool?.execute({ query: `OpenClaw partial answer with ${parts.length} parts` }),
    ).resolves.toMatchObject({
      content: expect.stringContaining("Partial answer"),
    });
  });

  it("does not contact Gemini for an already-cancelled search", async () => {
    const mockFetch = installGeminiFetch();
    const controller = new AbortController();
    const reason = new Error("Gemini search cancelled before billing");
    controller.abort(reason);
    const tool = createGeminiTool();

    await expect(
      tool?.execute({ query: "OpenClaw cancelled docs" }, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not cache a Gemini result completed after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("Gemini search cancelled after response");
    const mockFetch = installGeminiFetch();
    mockFetch.mockImplementationOnce(async () => {
      controller.abort(reason);
      return new Response(JSON.stringify(geminiAnswer("Cancelled grounded answer")));
    });
    const tool = createGeminiTool();
    const query = "OpenClaw late-cancel Gemini cache";

    await expect(tool?.execute({ query }, { signal: controller.signal })).rejects.toBe(reason);
    await tool?.execute({ query });

    const postCalls = postedCalls(mockFetch);
    expect(postCalls).toHaveLength(2);
  });

  it.each([
    ["provider key fallback", undefined, {}, "AIza-provider-test"],
    [
      "plugin key precedence",
      "AIza-env-test",
      createGeminiToolOptions().config,
      "AIza-plugin-test",
    ],
  ] as const)("resolves %s", async (label, envKey, config, expectedKey) => {
    await withEnvAsync({ GEMINI_API_KEY: envKey }, async () => {
      const mockFetch = installGeminiFetch();
      const tool = createGeminiWebSearchProvider().createTool({
        config: withGoogleModel(config, { apiKey: "AIza-provider-test" }),
        searchConfig: { provider: "gemini" },
      });
      await tool?.execute({ query: `OpenClaw ${label}` });
      expect(getFetchHeaders(mockFetch)["x-goog-api-key"]).toBe(expectedKey);
      expect(getFetchHeaders(mockFetch)["x-goog-api-client"]).toMatch(/^openclaw\//u);
    });
  });

  it.each([undefined, "https://generativelanguage.googleapis.com/plugin/v1beta/"])(
    "uses plugin baseUrl %s ahead of the provider fallback",
    async (baseUrl) => {
      const mockFetch = installGeminiFetch();
      const tool = createGeminiWebSearchProvider().createTool({
        config: withGoogleModel(createGeminiToolOptions({ baseUrl }).config, {
          baseUrl: "https://generativelanguage.googleapis.com/provider/v1beta/",
        }),
        searchConfig: { provider: "gemini" },
      });
      await tool?.execute({ query: `OpenClaw baseUrl ${baseUrl}` });
      expect(getGeminiFetchUrl(mockFetch)).toBe(
        `${baseUrl ?? "https://generativelanguage.googleapis.com/provider/v1beta/"}models/gemini-3.6-flash:generateContent`,
      );
    },
  );

  it("partitions Gemini cache entries for soft day freshness, hard week freshness, and no freshness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-15T12:00:00.123Z"));
    const mockFetch = installGeminiFetch();
    const tool = createGeminiTool();

    await tool?.execute({ query: "same query cache partition", freshness: "pd" });
    await tool?.execute({ query: "same query cache partition", freshness: "week" });
    await tool?.execute({ query: "same query cache partition" });

    const postCalls = postedCalls(mockFetch);
    expect(postCalls).toHaveLength(3);
    const firstBody = parseGeminiFetchBody(mockFetch, 0);
    const secondBody = parseGeminiFetchBody(mockFetch, 1);
    const thirdBody = parseGeminiFetchBody(mockFetch, 2);
    expect(firstBody.tools?.[0]?.google_search?.timeRangeFilter).toBeUndefined();
    expect(firstBody.contents?.[0]?.parts?.[0]?.text).toContain(
      "Prioritize web sources published in the last 24 hours.",
    );
    expect(secondBody.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-08T12:00:00Z",
      endTime: "2026-04-15T12:00:00Z",
    });
    expect(secondBody.contents?.[0]?.parts?.[0]?.text).toBe("same query cache partition");
    expect(thirdBody.tools?.[0]?.google_search?.timeRangeFilter).toBeUndefined();
    expect(thirdBody.contents?.[0]?.parts?.[0]?.text).toBe("same query cache partition");
  });

  it.each([
    {
      label: "relative freshness",
      filter: { freshness: "week" },
      equivalentFilter: { freshness: "pw" },
      distinctFilter: { freshness: "month" },
      initialTimeRange: {
        startTime: "2026-04-08T12:00:00Z",
        endTime: "2026-04-15T12:00:00Z",
      },
    },
    {
      label: "open-ended date ranges",
      filter: { date_after: "2026-04-01" },
      equivalentFilter: { date_after: "2026-04-01" },
      distinctFilter: { date_after: "2026-04-02" },
      initialTimeRange: {
        startTime: "2026-04-01T00:00:00Z",
        endTime: "2026-04-15T12:00:00Z",
      },
    },
  ])(
    "reuses Gemini $label cache entries as the clock advances without merging distinct filters",
    async ({ label, filter, equivalentFilter, distinctFilter, initialTimeRange }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-04-15T12:00:00.123Z"));
      const mockFetch = installGeminiFetch();
      const tool = createGeminiToolWithHeaders({});
      const query = `unique Gemini ${label} moving-clock cache regression`;

      await tool?.execute({ query, ...filter });
      vi.setSystemTime(new Date("2026-04-15T12:00:02.123Z"));
      const cached = await tool?.execute({ query, ...equivalentFilter });

      expect(cached).toMatchObject({ cached: true });
      expect(parseGeminiFetchBody(mockFetch).tools?.[0]?.google_search?.timeRangeFilter).toEqual(
        initialTimeRange,
      );

      await tool?.execute({ query, ...distinctFilter });
      const postCalls = postedCalls(mockFetch);
      expect(postCalls).toHaveLength(2);
    },
  );

  it("passes date ranges to Gemini Google Search grounding", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiTool();

    await tool?.execute({
      query: "OpenClaw release notes",
      date_after: "2026-04-01",
      date_before: "2026-04-30",
    });

    const body = parseGeminiFetchBody(mockFetch);
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-05-01T00:00:00Z",
    });
  });

  it("returns validation errors for invalid Gemini time filters before fetch", async () => {
    const mockFetch = installGeminiFetch();
    const tool = createGeminiTool();

    await expect(
      tool?.execute({
        query: "OpenClaw release notes",
        freshness: "week",
        date_after: "2026-04-01",
      }),
    ).resolves.toEqual({
      docs: "https://docs.openclaw.ai/tools/web",
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
