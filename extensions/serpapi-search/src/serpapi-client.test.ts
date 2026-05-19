import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const withTrustedWebSearchEndpoint = vi.fn();
const readCachedSearchPayload = vi.fn(() => undefined);
const writeCachedSearchPayload = vi.fn();
const buildSearchCacheKey = vi.fn((...args: unknown[]) => JSON.stringify(args));

vi.mock("openclaw/plugin-sdk/provider-web-search", () => ({
  withTrustedWebSearchEndpoint,
  readCachedSearchPayload,
  writeCachedSearchPayload,
  buildSearchCacheKey,
}));

vi.mock("./config.js", () => ({
  SERPAPI_BASE_URL: "https://serpapi.com/search",
  SERPAPI_CACHE_TTL_MS: 55 * 60_000,
  DEFAULT_SERPAPI_TIMEOUT_SECONDS: 30,
  resolveSerpApiKey: vi.fn(() => "test-api-key"),
  resolveSerpApiLanguage: vi.fn(() => "en"),
}));

describe("callSerpApi", () => {
  let callSerpApi: typeof import("./serpapi-client.js").callSerpApi;
  let configMock: typeof import("./config.js");

  beforeAll(async () => {
    ({ callSerpApi } = await import("./serpapi-client.js"));
    configMock = await import("./config.js");
  });

  beforeEach(() => {
    withTrustedWebSearchEndpoint.mockReset();
    readCachedSearchPayload.mockReset();
    writeCachedSearchPayload.mockReset();
    buildSearchCacheKey.mockClear();

    vi.mocked(configMock.resolveSerpApiKey).mockReturnValue("test-api-key");
    vi.mocked(configMock.resolveSerpApiLanguage).mockReturnValue("en");
    readCachedSearchPayload.mockReturnValue(undefined);
    withTrustedWebSearchEndpoint.mockImplementation(
      async (_opts: unknown, handler: (r: Response) => Promise<unknown>) =>
        handler(Response.json({ organic_results: [] })),
    );
  });

  it("throws when API key is missing", async () => {
    vi.mocked(configMock.resolveSerpApiKey).mockReturnValue(undefined);

    await expect(
      callSerpApi({ engine: "google", allowedParams: ["q"], params: { q: "test" } }),
    ).rejects.toThrow("SerpApi API key");
  });

  it("sends engine and hl always, plus allowlisted params", async () => {
    await callSerpApi({
      engine: "google",
      allowedParams: ["q", "gl"],
      params: { q: "openclaw", gl: "ua", secret: "should-be-stripped" },
    });

    expect(withTrustedWebSearchEndpoint).toHaveBeenCalledOnce();
    const opts = withTrustedWebSearchEndpoint.mock.calls[0][0] as { url: string };
    const url = new URL(opts.url);
    expect(url.searchParams.get("engine")).toBe("google");
    expect(url.searchParams.get("hl")).toBe("en");
    expect(url.searchParams.get("q")).toBe("openclaw");
    expect(url.searchParams.get("gl")).toBe("ua");
    expect(url.searchParams.has("secret")).toBe(false);
    expect(url.searchParams.get("api_key")).toBe("test-api-key");
  });

  it("omits undefined and empty-string params", async () => {
    await callSerpApi({
      engine: "google",
      allowedParams: ["q", "location"],
      params: { q: "test", location: undefined, gl: "" },
    });

    const opts = withTrustedWebSearchEndpoint.mock.calls[0][0] as { url: string };
    const url = new URL(opts.url);
    expect(url.searchParams.has("location")).toBe(false);
    expect(url.searchParams.has("gl")).toBe(false);
  });

  it("returns cached result without calling HTTP endpoint", async () => {
    const cached = { organic_results: [{ title: "cached" }] };
    readCachedSearchPayload.mockReturnValue(cached);

    const result = await callSerpApi({
      engine: "google",
      allowedParams: ["q"],
      params: { q: "test" },
    });

    expect(result).toBe(cached);
    expect(withTrustedWebSearchEndpoint).not.toHaveBeenCalled();
  });

  it("writes result to cache after successful fetch", async () => {
    const data = { organic_results: [{ title: "fresh" }] };
    withTrustedWebSearchEndpoint.mockImplementationOnce(
      async (_opts: unknown, handler: (r: Response) => Promise<unknown>) =>
        handler(Response.json(data)),
    );

    await callSerpApi({
      engine: "google",
      allowedParams: ["q"],
      params: { q: "test" },
    });

    expect(writeCachedSearchPayload).toHaveBeenCalledOnce();
    const [, written] = writeCachedSearchPayload.mock.calls[0];
    expect(written).toEqual(data);
  });

  it("skips cache read and write for zero_trace requests", async () => {
    await callSerpApi({
      engine: "google",
      allowedParams: ["q", "zero_trace"],
      params: { q: "private", zero_trace: "true" },
    });

    expect(readCachedSearchPayload).not.toHaveBeenCalled();
    expect(writeCachedSearchPayload).not.toHaveBeenCalled();
  });

  it("throws stable error on 401", async () => {
    withTrustedWebSearchEndpoint.mockImplementationOnce(
      async (_opts: unknown, handler: (r: Response) => Promise<unknown>) =>
        handler(new Response("Unauthorized", { status: 401 })),
    );

    await expect(
      callSerpApi({ engine: "google", allowedParams: ["q"], params: { q: "test" } }),
    ).rejects.toThrow("SerpApi: invalid or missing API key.");
  });

  it("throws stable error on 429", async () => {
    withTrustedWebSearchEndpoint.mockImplementationOnce(
      async (_opts: unknown, handler: (r: Response) => Promise<unknown>) =>
        handler(new Response("Too Many Requests", { status: 429 })),
    );

    await expect(
      callSerpApi({ engine: "google", allowedParams: ["q"], params: { q: "test" } }),
    ).rejects.toThrow("SerpApi: quota exhausted.");
  });

  it("throws stable error on 500+", async () => {
    withTrustedWebSearchEndpoint.mockImplementationOnce(
      async (_opts: unknown, handler: (r: Response) => Promise<unknown>) =>
        handler(new Response("Internal Server Error", { status: 500 })),
    );

    await expect(
      callSerpApi({ engine: "google", allowedParams: ["q"], params: { q: "test" } }),
    ).rejects.toThrow("SerpApi: upstream error (500)");
  });

  it("throws stable error on malformed JSON", async () => {
    withTrustedWebSearchEndpoint.mockImplementationOnce(
      async (_opts: unknown, handler: (r: Response) => Promise<unknown>) =>
        handler(new Response("{ not json", { status: 200 })),
    );

    await expect(
      callSerpApi({ engine: "google_news", allowedParams: ["q"], params: { q: "test" } }),
    ).rejects.toThrow("SerpApi (google_news): malformed JSON response");
  });

  it("sends X-Client-Source: openclaw header", async () => {
    await callSerpApi({
      engine: "google",
      allowedParams: ["q"],
      params: { q: "test" },
    });

    const opts = withTrustedWebSearchEndpoint.mock.calls[0][0] as {
      init: { headers: Record<string, string> };
    };
    expect(opts.init.headers["X-Client-Source"]).toBe("openclaw");
  });
});
