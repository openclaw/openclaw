import { once } from "node:events";
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as authRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { acquireTestPortBlock, useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("registered ClawRouter web search over HTTP", () => {
  useIsolatedStateGuard();
  const captured = createCapturedPluginRegistration();
  plugin.register?.(captured.api);
  let baseUrl: string;
  let releasePort: () => Promise<void>;
  let eligible = true;
  let routeKind = "native";
  let format = "tavily.search";
  let responseFormat: string | undefined;
  let methods: string[] | undefined;
  const fixtures = [
    {
      id: "tavily",
      path: "/search",
      method: "POST",
      body: { query: "synthetic query", max_results: 2 },
      // Emoji straddle the 500-unit title and 4,000-unit snippet caps.
      row: {
        title: "Synthetic result".padEnd(499, ".") + "🥐",
        content: "Fixture snippet".padEnd(3_999, ".") + "🥐",
      },
      field: "snippet",
    },
    {
      id: "brave",
      path: "/res/v1/web/search",
      method: "GET",
      query: "q=synthetic+query&count=2",
      row: { description: "Fixture snippet", page_age: "2026-01-01" },
      field: "description",
    },
    {
      id: "exa",
      path: "/search",
      method: "POST",
      body: {
        query: "synthetic query",
        numResults: 2,
        type: "auto",
        contents: { highlights: true },
      },
      row: {
        highlights: ["Fixture snippet"],
        summary: "Fixture summary",
        highlightScores: [0.8],
        publishedDate: "2026-01-01",
      },
      field: "description",
    },
    {
      id: "parallel",
      path: "/v1/search",
      method: "POST",
      body: { search_queries: ["synthetic query"], advanced_settings: { max_results: 2 } },
      row: { excerpts: ["Fixture snippet"], publish_date: "2026-01-01" },
      field: "description",
    },
    {
      id: "searxng",
      path: "/search",
      method: "GET",
      query: "q=synthetic+query&format=json",
      row: { content: "Fixture snippet", img_src: "https://example.com/image.png" },
      field: "snippet",
    },
  ];
  const fixture = () => fixtures.find((value) => `${value.id}.search` === format) ?? fixtures[0]!;
  const calls: Array<{
    path: string;
    method?: string;
    auth?: string;
    upstreamAuth?: string;
    body: unknown;
  }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await buffer(request);
      calls.push({
        path: request.url ?? "",
        method: request.method,
        upstreamAuth: (request.headers["x-api-key"] ?? request.headers["x-subscription-token"]) as
          | string
          | undefined,
        auth: request.headers.authorization,
        body: body.length ? JSON.parse(body.toString()) : undefined,
      });
      const selected = fixture();
      const results = [
        { title: "Synthetic result", url: "https://example.com/search", ...selected.row },
        { title: "Unsafe link", url: "javascript:alert(1)", ...selected.row },
      ];
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/v1/catalog"
            ? {
                version: "clawrouter.client-catalog.v1",
                providers: [
                  {
                    id: selected.id,
                    allowed: true,
                    executable: true,
                    nativeBaseUrl: `/v1/native/${selected.id}`,
                    models: [],
                    routes: [
                      {
                        endpoint: "search",
                        path: selected.path,
                        methods: methods ?? [selected.method],
                        requestFormat: format,
                        responseFormat: responseFormat ?? format,
                      },
                    ],
                    offers: [
                      {
                        endpoint: "search",
                        modelId: null,
                        eligible,
                        affordability: "request-dependent",
                        transport: "http",
                        routeKind,
                        route:
                          routeKind === "native"
                            ? `/v1/native/${selected.id}${selected.path}`
                            : `/v1/proxy/${selected.id}/search`,
                      },
                    ],
                  },
                ],
              }
            : format === "brave.search"
              ? { web: { results } }
              : { results },
        ),
      );
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  beforeAll(async () => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    releasePort = claim.release;
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${claim.port}/v1`;
  });
  afterAll(async () => {
    const closed = server[Symbol.asyncDispose]();
    server.closeAllConnections();
    await closed;
    await releasePort();
  });
  beforeEach(() => {
    calls.length = 0;
    eligible = true;
    routeKind = "native";
    format = "tavily.search";
    responseFormat = undefined;
    methods = undefined;
    vi.spyOn(authRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "synthetic-router-key",
      source: "test",
      mode: "api-key",
    });
  });
  afterEach(() => vi.restoreAllMocks());
  const tool = () =>
    captured.webSearchProviders
      .find((provider) => provider.id === "clawrouter")!
      .createTool({
        config: {
          models: {
            providers: {
              clawrouter: { baseUrl, apiKey: "synthetic-router-key", models: [] },
              tavily: {
                baseUrl: "https://upstream.example",
                apiKey: "unused-upstream-key",
                models: [],
              },
            },
          },
        },
      })!;

  it.each(
    fixtures.flatMap((entry) =>
      ["native", "manifest"].map((kind) => Object.assign({}, entry, { kind })),
    ),
  )("executes $id through the advertised $kind model-less offer", async (entry) => {
    routeKind = entry.kind;
    format = `${entry.id}.search`;
    const result = await tool().execute({ query: "synthetic query", count: 2 });
    expect(result).toMatchObject({
      provider: "clawrouter",
      count: 1,
      results: [
        {
          url: "https://example.com/search",
          title: expect.stringContaining("Synthetic result"),
          [entry.field]: expect.stringMatching(/EXTERNAL_UNTRUSTED_CONTENT[\s\S]*Fixture snippet/),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("\\ud83e");
    if (entry.id === "exa") {
      expect(result.results).toEqual([
        expect.objectContaining({
          summary: expect.stringContaining("Fixture summary"),
          highlightScores: [0.8],
          published: "2026-01-01",
        }),
      ]);
    }
    if (entry.id === "parallel") {
      expect(result.results).toEqual([
        expect.objectContaining({
          excerpts: [expect.stringContaining("Fixture snippet")],
          published: "2026-01-01",
        }),
      ]);
    }
    const route =
      entry.kind === "native"
        ? `/v1/native/${entry.id}${entry.path}`
        : `/v1/proxy/${entry.id}/search`;
    expect(calls).toEqual([
      {
        path: "/v1/catalog",
        method: "GET",
        auth: "Bearer synthetic-router-key",
        body: undefined,
      },
      {
        path: `${route}${entry.query ? `?${entry.query}` : ""}`,
        method: entry.method,
        auth: "Bearer synthetic-router-key",
        body: entry.body && entry.kind === "manifest" ? { body: entry.body } : entry.body,
      },
    ]);
    expect(calls.at(-1)?.upstreamAuth).toBeUndefined();
    expect(authRuntime.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "clawrouter" }),
    );
  });

  it("rejects mismatched native formats and methods before dispatch", async () => {
    format = "brave.search";
    responseFormat = "exa.search";
    await expect(tool().execute({ query: "mismatch" })).rejects.toThrow("no eligible search offer");
    responseFormat = undefined;
    methods = ["POST"];
    await expect(tool().execute({ query: "wrong method" })).rejects.toThrow(
      "no eligible search offer",
    );
    expect(calls.map((call) => call.path)).toEqual(["/v1/catalog", "/v1/catalog"]);
  });

  it("does not silently truncate a query outside the Parallel wire limit", async () => {
    format = "parallel.search";
    await expect(tool().execute({ query: "x".repeat(201) })).rejects.toThrow(
      "200 query characters",
    );
    expect(calls.map((call) => call.path)).toEqual(["/v1/catalog"]);
  });

  it("refreshes grants and credentials for each execution without upstream fallback", async () => {
    await tool().execute({ query: "first" });
    eligible = false;
    vi.mocked(authRuntime.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "rotated-router-key",
      source: "test",
      mode: "api-key",
    });
    await expect(tool().execute({ query: "denied" })).rejects.toThrow("no eligible search offer");
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/catalog",
      "/v1/native/tavily/search",
      "/v1/catalog",
    ]);
    expect(calls.at(-1)?.auth).toBe("Bearer rotated-router-key");
    expect(
      vi
        .mocked(authRuntime.resolveApiKeyForProvider)
        .mock.calls.every(([args]) => args.provider === "clawrouter"),
    ).toBe(true);
  });

  it("rejects unknown formats and cancellation before transport admission", async () => {
    format = "future.search";
    await expect(tool().execute({ query: "unknown" })).rejects.toThrow("no eligible search offer");
    expect(calls).toHaveLength(1);
    const abort = new AbortController();
    abort.abort();
    await expect(
      tool().execute({ query: "cancelled" }, { signal: abort.signal }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    format = "tavily.search";
    let admissions = 0;
    await expect(
      tool().execute(
        { query: "stale" },
        {
          assertCurrent: () => {
            if (++admissions === 2) {
              throw new Error("stale execution");
            }
          },
        },
      ),
    ).rejects.toThrow("stale execution");
    expect(calls).toHaveLength(2);
  });
});
