import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describeWebSearchProviderContracts } from "openclaw/plugin-sdk/provider-test-contracts";
import { jsonResponse, mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_MODEL_CATALOG } from "./models.js";
import { createDeepSeekWebSearchProvider } from "./web-search-provider.js";

const KEY = "deepseek-synthetic-search-key";
const fetch = vi.fn<typeof globalThis.fetch>();
function requestBody(index = 0) {
  const body = fetch.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected serialized search request body");
  }
  return JSON.parse(body);
}
function modelKey(baseUrl?: string, modelBaseUrl?: string): OpenClawConfig {
  const model = expectDefined(DEEPSEEK_MODEL_CATALOG[0], "Expected a bundled DeepSeek model");
  const deepseek = {
    apiKey: "model-key",
    models: modelBaseUrl ? [{ ...model, baseUrl: modelBaseUrl }] : [],
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
  return { models: { providers: { deepseek } } } as OpenClawConfig;
}
const CHAT_PROXY = "https://chat-proxy.example/v1";
// The model-provider key belongs to chat's routes; only DeepSeek's own API origin may reuse it.
const CHAT_ROUTES = [
  [undefined, undefined, true],
  ["", undefined, true],
  ["https://api.deepseek.com", undefined, true],
  ["https://api.deepseek.com/v1", undefined, true],
  ["https://API.DeepSeek.com/beta", undefined, true],
  ["https://api.deepseek.com./v1", undefined, true],
  ["https://api.deepseek.com:443", undefined, true],
  [CHAT_PROXY, undefined, false],
  ["https://api.deepseek.com.chat-proxy.example/v1", undefined, false],
  ["https://chat-proxy.example/api.deepseek.com/v1", undefined, false],
  ["https://proxy-user@api.deepseek.com/v1", undefined, false],
  ["https://api.deepseek.com:8443/v1", undefined, false],
  ["http://api.deepseek.com", undefined, false],
  ["blob:https://api.deepseek.com/v1", undefined, false],
  ["api.deepseek.com", undefined, false],
  ["not a url", undefined, false],
  [undefined, "https://api.deepseek.com/v1", true],
  [undefined, CHAT_PROXY, false],
  ["https://api.deepseek.com", CHAT_PROXY, false],
] as const;
function searchTool(config: OpenClawConfig = {}, searchConfig: Record<string, unknown> = {}) {
  return expectDefined(
    createDeepSeekWebSearchProvider().createTool({ config, searchConfig }),
    "Expected DeepSeek search tool",
  );
}
function configKey(apiKey: unknown): OpenClawConfig {
  return { plugins: { entries: { deepseek: { config: { webSearch: { apiKey } } } } } };
}
const response = (results: object[] = [{ url: "https://docs.openclaw.ai/" }]) =>
  jsonResponse({ results });
async function failedSearch(failureResponse: Response, query: string) {
  fetch.mockResolvedValueOnce(failureResponse).mockResolvedValueOnce(response());
  const tool = searchTool();
  const failure: unknown = await tool.execute({ query }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(fetch).toHaveBeenCalledOnce();
  expect(await tool.execute({ query })).toMatchObject({ count: 1 });
  expect(fetch).toHaveBeenCalledTimes(2);
  return failure;
}

describeWebSearchProviderContracts("deepseek");
it("exposes the current model credential as raw fallback metadata", () => {
  const fallback = expectDefined(
    createDeepSeekWebSearchProvider().getConfiguredCredentialFallback,
    "Expected model credential fallback",
  );
  expect(fallback()).toBeUndefined();
  const config = modelKey("https://api.deepseek.com");
  expect(fallback(config)).toEqual({
    path: "models.providers.deepseek.apiKey",
    value: "model-key",
  });
  const ref = { source: "env", provider: "default", id: "SYNTHETIC_DEEPSEEK_KEY" } as const;
  const provider = expectDefined(config.models?.providers?.deepseek, "Expected model provider");
  provider.apiKey = ref;
  expect(fallback(config)).toEqual({ path: "models.providers.deepseek.apiKey", value: ref });
  expect(fallback(config)?.value).toBe(ref);
});

describe("DeepSeek search execution", () => {
  beforeEach(() => {
    vi.stubEnv("DEEPSEEK_API_KEY", KEY);
    mockPinnedHostnameResolution();
    fetch.mockReset().mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["plugin key before env/model", configKey("plugin-key"), KEY, "plugin-key"],
    ["env before model", modelKey("https://api.deepseek.com"), KEY, KEY],
    ["env with a chat proxy", modelKey("https://chat-proxy.example/v1"), KEY, KEY],
    ["model fallback", modelKey("https://api.deepseek.com"), undefined, "model-key"],
  ] as const)("resolves %s at the search endpoint", async (label, config, env, expected) => {
    vi.stubEnv("DEEPSEEK_API_KEY", env);
    await searchTool(config).execute({ query: `credential ${label}` });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/v1/tools/search");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${expected}`,
    );
  });

  it.each(CHAT_ROUTES)(
    "reuses the model key only on DeepSeek's API (provider %s, model %s): %s",
    async (baseUrl, modelBaseUrl, owned) => {
      vi.stubEnv("DEEPSEEK_API_KEY", undefined);
      const query = `chat ${baseUrl} model ${modelBaseUrl}`;
      const result = await searchTool(modelKey(baseUrl, modelBaseUrl)).execute({ query });
      if (owned) {
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
          "Bearer model-key",
        );
      } else {
        expect(result).toMatchObject({ error: "missing_deepseek_api_key" });
        expect(fetch).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [CHAT_PROXY, "https://api.deepseek.com"],
    ["https://api.deepseek.com", CHAT_PROXY],
  ])(
    "does not reuse a model key while any entry for the provider routes chat elsewhere (%s, %s)",
    async (first, second) => {
      vi.stubEnv("DEEPSEEK_API_KEY", undefined);
      // Whitespace variants of one provider id: chat reads key and route through different views.
      const providers = {
        deepseek: { apiKey: "model-key", baseUrl: first, models: [] },
        " deepseek ": { baseUrl: second, models: [] },
      };
      await expect(
        searchTool({ models: { providers } }).execute({ query: `variants ${first} ${second}` }),
      ).resolves.toMatchObject({ error: "missing_deepseek_api_key" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reports missing and unresolved credentials without network access", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    await expect(searchTool().execute({ query: "missing credential" })).resolves.toMatchObject({
      error: "missing_deepseek_api_key",
    });
    await expect(
      searchTool(configKey({ source: "file", provider: "default", id: "/key" })).execute({
        query: "unresolved credential",
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts 128 Unicode code points but never truncates oversized queries", async () => {
    const query = "🦞".repeat(128);
    await searchTool().execute({ query });
    expect(requestBody().query).toBe(query);
    await expect(searchTool().execute({ query: query + "a" })).resolves.toMatchObject({
      error: "invalid_query",
    });
    for (const invalid of ["", "  ", undefined]) {
      await expect(searchTool().execute({ query: invalid })).rejects.toThrow();
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    "country",
    "language",
    "freshness",
    "date_after",
    "date_before",
    "search_lang",
    "ui_lang",
    "domain_filter",
    "max_tokens",
    "max_tokens_per_page",
  ])("rejects %s before buying a search", async (key) => {
    await expect(
      searchTool().execute({ query: "unsupported filter", [key]: "value" }),
    ).resolves.toMatchObject({
      error: "unsupported_filter",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses count defaults, configuration, and explicit overrides", async () => {
    const defaults = searchTool();
    const configured = searchTool({}, { maxResults: 2 });
    expect(defaults.parameters).toBe(configured.parameters);
    await defaults.execute({ query: "count defaults" });
    await configured.execute({ query: "count configured" });
    await searchTool({}, { maxResults: 2 }).execute({ query: "count override", count: 10 });
    await expect(searchTool().execute({ query: "invalid count", count: 11 })).rejects.toThrow(
      "count must be an integer",
    );
    expect(fetch.mock.calls.map((_, index) => requestBody(index).count)).toEqual([5, 2, 10]);
  });

  it("caches empty results separately by count/key/query", async () => {
    fetch.mockImplementation(async () => response([]));
    const tool = searchTool();
    const query = "cache identity DeepSeek";
    expect(await tool.execute({ query })).toMatchObject({ count: 0, results: [] });
    expect(await tool.execute({ query })).toMatchObject({ cached: true });
    await tool.execute({ query, count: 1 });
    await tool.execute({ query: query.toLowerCase() });
    vi.stubEnv("DEEPSEEK_API_KEY", "another-synthetic-key");
    await tool.execute({ query });
    vi.stubEnv("DEEPSEEK_API_KEY", KEY);
    expect(await tool.execute({ query })).toMatchObject({ cached: true });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("falls back to UI snippets, preserves ordering, and caps returned rows", async () => {
    fetch.mockResolvedValue(
      response([
        {
          title: "First",
          url: "https://one.example",
          summary: " ",
          snippet: "UI fallback",
          date: null,
          site_name: null,
          content: "Full content must not escape",
          authority: 3,
          rerank_score: 2.4,
        },
        { title: "Second", url: "https://two.example", summary: "Second summary" },
        { title: "Third", url: "https://three.example" },
      ]),
    );
    const result = await searchTool().execute({ query: "fallback snippets", count: 2 });
    expect(requestBody()).toEqual({ query: "fallback snippets", count: 2, need_content: false });
    expect(result.results).toEqual(
      [
        { title: "First", url: "https://one.example/", snippet: "UI fallback" },
        { title: "Second", url: "https://two.example/", snippet: "Second summary" },
      ].map((row) => Object.assign(row, { published: undefined, siteName: undefined })),
    );
    expect(result.count).toBe(2);
  });

  it.each(["{ nope", "[]", "{}", '{"results":{}}'])("rejects %s without caching", async (body) => {
    expect(await failedSearch(new Response(body), `bad response ${body}`)).toMatchObject({
      message: expect.stringContaining("malformed JSON response"),
    });
  });

  it("preserves HTTP errors without secrets, retries, or caching", async () => {
    const status = 401;
    const failure = await failedSearch(
      new Response(`reflected Bearer ${KEY}`, { status }),
      `http error ${status}`,
    );
    expect(failure).toMatchObject({ status });
    expect(String(failure)).not.toContain(KEY);
  });

  it("cancels in-flight work and never caches a late response", async () => {
    const responseReady = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    fetch
      .mockImplementationOnce((_url, init) => {
        started.resolve();
        expect(init?.signal).toBeDefined();
        return responseReady.promise;
      })
      .mockResolvedValue(response());
    const tool = searchTool();
    const query = "late cancellation";
    const controller = new AbortController();
    const pending = tool.execute({ query }, { signal: controller.signal });
    await started.promise;
    const reason = new Error("DeepSeek caller cancelled");
    controller.abort(reason);
    responseReady.resolve(response());
    await expect(pending).rejects.toBe(reason);
    await tool.execute({ query });
    expect(fetch).toHaveBeenCalledTimes(2);
    const aborted = new AbortController();
    aborted.abort(reason);
    await expect(tool.execute({ query }, { signal: aborted.signal })).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
