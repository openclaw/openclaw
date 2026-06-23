// Tavily tests cover tavily client plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every call to postTrustedWebToolsJson so we can assert on extraHeaders.
const postTrustedWebToolsJson = vi.fn();

vi.mock("openclaw/plugin-sdk/provider-web-search", () => ({
  DEFAULT_CACHE_TTL_MINUTES: 5,
  normalizeCacheKey: (k: string) => k,
  postTrustedWebToolsJson,
  readCache: () => undefined,
  resolveCacheTtlMs: () => 300_000,
  writeCache: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  wrapExternalContent: (v: string) => v,
  wrapWebContent: (v: string) => v,
}));

vi.mock("./config.js", () => ({
  DEFAULT_TAVILY_BASE_URL: "https://api.tavily.com",
  resolveTavilyApiKey: () => "test-key",
  resolveTavilyBaseUrl: () => "https://api.tavily.com",
  resolveTavilySearchTimeoutSeconds: () => 30,
  resolveTavilyExtractTimeoutSeconds: () => 60,
}));

// Streaming JSON fixture (no content-length) that counts reads so a test can
// prove the bounded reader stops before buffering the whole oversized body.
function createStreamingJsonResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
} {
  let reads = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("a".repeat(params.chunkSize)));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    getReadCount: () => reads,
  };
}

describe("tavily client X-Client-Source header", () => {
  let runTavilySearch: typeof import("./tavily-client.js").runTavilySearch;
  let runTavilyExtract: typeof import("./tavily-client.js").runTavilyExtract;
  let testing: typeof import("./tavily-client.js").__testing;

  beforeAll(async () => {
    ({
      runTavilySearch,
      runTavilyExtract,
      __testing: testing,
    } = await import("./tavily-client.js"));
  });

  beforeEach(() => {
    postTrustedWebToolsJson.mockReset();
    postTrustedWebToolsJson.mockImplementation(
      async (_params: unknown, parse: (r: Response) => Promise<unknown>) =>
        parse(Response.json({ results: [] })),
    );
  });

  it("runTavilySearch sends X-Client-Source: openclaw", async () => {
    await runTavilySearch({ query: "test query" });

    expect(postTrustedWebToolsJson).toHaveBeenCalledOnce();
    const params = postTrustedWebToolsJson.mock.calls[0]?.[0];
    expect(params.extraHeaders).toEqual({ "X-Client-Source": "openclaw" });
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

  it("parses well-formed JSON responses under the byte cap", async () => {
    const response = new Response(JSON.stringify({ results: [{ url: "https://e.com" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(testing.readTavilyJsonResponse(response, "Tavily Search")).resolves.toEqual({
      results: [{ url: "https://e.com" }],
    });
  });

  it("caps oversized JSON responses instead of buffering the whole body", async () => {
    // 20 x 1 KiB chunks behind a 2 KiB cap: the reader must stop early.
    const streamed = createStreamingJsonResponse({ chunkCount: 20, chunkSize: 1024 });

    await expect(
      testing.readTavilyJsonResponse(streamed.response, "Tavily Search", { maxBytes: 2048 }),
    ).rejects.toThrow("Tavily Search: JSON response exceeds 2048 bytes");

    expect(streamed.getReadCount()).toBeLessThan(20);
  });
});
