import type { OpenClawCredentialBroker } from "openclaw/plugin-sdk/plugin-entry";
// Tavily tests cover tavily client plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";

// Capture every call to postTrustedWebToolsJson so we can assert on extraHeaders.
const postTrustedWebToolsJson = vi.fn();
const resolveTavilyApiKey = vi.fn(() => "test-key");
const readCache = vi.fn<() => { value: Record<string, unknown> } | undefined>(() => undefined);
const deniedBroker: OpenClawCredentialBroker = {
  isConfigured: () => true,
  createRequest: () => {
    throw new Error("denied by scope");
  },
};

vi.mock("openclaw/plugin-sdk/provider-web-search", () => ({
  DEFAULT_CACHE_TTL_MINUTES: 5,
  normalizeCacheKey: (k: string) => k,
  postTrustedWebToolsJson,
  readCache,
  resolveCacheTtlMs: () => 300_000,
  writeCache: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  wrapExternalContent: (v: string) => v,
  wrapWebContent: (v: string) => v,
}));

vi.mock("./config.js", () => ({
  DEFAULT_TAVILY_BASE_URL: "https://api.tavily.com",
  resolveTavilyApiKey,
  resolveTavilyBaseUrl: () => "https://api.tavily.com",
  resolveTavilySearchTimeoutSeconds: () => 30,
  resolveTavilyExtractTimeoutSeconds: () => 60,
}));

describe("tavily client X-Client-Source header", () => {
  let runTavilySearch: typeof import("./tavily-client.js").runTavilySearch;
  let runTavilyExtract: typeof import("./tavily-client.js").runTavilyExtract;

  beforeAll(async () => {
    ({ runTavilySearch, runTavilyExtract } = await import("./tavily-client.js"));
  });

  beforeEach(() => {
    postTrustedWebToolsJson.mockReset();
    readCache.mockReset();
    readCache.mockReturnValue(undefined);
    resolveTavilyApiKey.mockClear();
    postTrustedWebToolsJson.mockImplementation(
      async (_params: unknown, parse: (r: Response) => Promise<unknown>) =>
        parse(Response.json({ results: [] })),
    );
  });

  it("runTavilySearch sends X-Client-Source: openclaw", async () => {
    const signal = new AbortController().signal;
    await runTavilySearch({ query: "test query", signal });

    expect(postTrustedWebToolsJson).toHaveBeenCalledOnce();
    const params = postTrustedWebToolsJson.mock.calls[0]?.[0];
    expect(params.extraHeaders).toEqual({ "X-Client-Source": "openclaw" });
    expect(params.signal).toBe(signal);
  });

  it("routes a configured SecretRef operation through the credential broker", async () => {
    const execute = vi.fn(async () => ({ status: 200, body: { results: [] } }));
    const credentialBroker: OpenClawCredentialBroker = {
      isConfigured: (operationId) => operationId === "search",
      createRequest: vi.fn(({ operationId }: { operationId: string }) => ({
        id: "opaque-request",
        operationId,
        expiresAtMs: 30_000,
        execute,
        revoke: vi.fn(),
        toJSON: () => ({
          id: "opaque-request",
          operationId,
          expiresAtMs: 30_000,
          state: "pending" as const,
        }),
      })),
    };

    const signal = new AbortController().signal;
    await runTavilySearch({ query: "test query", credentialBroker, signal });

    expect(credentialBroker.createRequest).toHaveBeenCalledWith({
      operationId: "search",
      body: {
        query: "test query",
        max_results: 5,
      },
    });
    expect(execute).toHaveBeenCalledWith({ signal });
    expect(resolveTavilyApiKey).not.toHaveBeenCalled();
    expect(postTrustedWebToolsJson).not.toHaveBeenCalled();
  });

  it("does not fall back to resolved plaintext when a SecretRef requires the broker", async () => {
    await expect(
      runTavilySearch({ query: "test query", requiresCredentialBroker: true }),
    ).rejects.toThrow("requires a conversation-scoped credential broker");

    expect(resolveTavilyApiKey).not.toHaveBeenCalled();
    expect(postTrustedWebToolsJson).not.toHaveBeenCalled();
  });

  it.each([
    {
      operationId: "search",
      run: () => runTavilySearch({ query: "cached", credentialBroker: deniedBroker }),
    },
    {
      operationId: "extract",
      run: () =>
        runTavilyExtract({ urls: ["https://example.com/cached"], credentialBroker: deniedBroker }),
    },
  ])("authorizes brokered $operationId operations before cache reads", async ({ run }) => {
    readCache.mockReturnValueOnce({ value: { results: [] } });

    await expect(run()).rejects.toThrow("denied by scope");

    expect(readCache).not.toHaveBeenCalled();
    expect(postTrustedWebToolsJson).not.toHaveBeenCalled();
  });

  it("runTavilySearch reports malformed JSON with a stable provider error", async () => {
    postTrustedWebToolsJson.mockImplementationOnce(
      async (_params: unknown, parse: (r: Response) => Promise<unknown>) =>
        parse(new Response("{ nope")),
    );

    await expect(runTavilySearch({ query: "test query" })).rejects.toThrow(
      "Tavily Search: malformed JSON response",
    );
  });

  it("bounds successful Tavily JSON bodies before parsing", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const jsonSpy = vi.spyOn(streamed.response, "json").mockRejectedValue(new Error("unbounded"));

    postTrustedWebToolsJson.mockImplementationOnce(
      async (_params: unknown, parse: (r: Response) => Promise<unknown>) =>
        parse(streamed.response),
    );

    await expect(runTavilySearch({ query: "test query" })).rejects.toThrow(
      "Tavily Search: JSON response exceeds 16777216 bytes",
    );

    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("runTavilyExtract sends X-Client-Source: openclaw", async () => {
    await runTavilyExtract({ urls: ["https://example.com"] });

    expect(postTrustedWebToolsJson).toHaveBeenCalledOnce();
    const params = postTrustedWebToolsJson.mock.calls[0]?.[0];
    expect(params.extraHeaders).toEqual({ "X-Client-Source": "openclaw" });
  });

  it("runTavilyExtract reports malformed JSON with a stable provider error", async () => {
    postTrustedWebToolsJson.mockImplementationOnce(
      async (_params: unknown, parse: (r: Response) => Promise<unknown>) =>
        parse(new Response("{ nope")),
    );

    await expect(runTavilyExtract({ urls: ["https://example.com"] })).rejects.toThrow(
      "Tavily Extract: malformed JSON response",
    );
  });
});
