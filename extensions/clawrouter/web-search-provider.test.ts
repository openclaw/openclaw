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
  const calls: Array<{ path: string; auth?: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await buffer(request);
      calls.push({
        path: request.url ?? "",
        auth: request.headers.authorization,
        body: body.length ? JSON.parse(body.toString()) : undefined,
      });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/v1/catalog"
            ? {
                version: "clawrouter.client-catalog.v1",
                providers: [
                  {
                    id: "tavily",
                    allowed: true,
                    executable: true,
                    nativeBaseUrl: "/v1/native/tavily",
                    models: [],
                    routes: [
                      {
                        endpoint: "search",
                        path: "/search",
                        methods: ["POST"],
                        requestFormat: format,
                        responseFormat: format,
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
                            ? "/v1/native/tavily/search"
                            : "/v1/proxy/tavily/search",
                      },
                    ],
                  },
                ],
              }
            : {
                results: [
                  {
                    title: "Synthetic result",
                    url: "https://example.com/search",
                    content: "Fixture snippet",
                  },
                  { title: "Unsafe link", url: "javascript:alert(1)", content: "Ignored" },
                ],
              },
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

  it.each(["native", "manifest"])("executes the advertised %s model-less offer", async (kind) => {
    routeKind = kind;
    const result = await tool().execute({ query: "synthetic query", count: 2 });
    expect(result).toMatchObject({
      provider: "clawrouter",
      count: 1,
      results: [
        {
          url: "https://example.com/search",
          title: expect.stringContaining("Synthetic result"),
          snippet: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
        },
      ],
    });
    expect(calls).toEqual([
      { path: "/v1/catalog", auth: "Bearer synthetic-router-key", body: undefined },
      {
        path: kind === "native" ? "/v1/native/tavily/search" : "/v1/proxy/tavily/search",
        auth: "Bearer synthetic-router-key",
        body: { query: "synthetic query", max_results: 2 },
      },
    ]);
    expect(authRuntime.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "clawrouter" }),
    );
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
