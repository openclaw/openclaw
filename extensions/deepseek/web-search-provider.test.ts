import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describeWebSearchProviderContracts } from "openclaw/plugin-sdk/provider-test-contracts";
import { jsonResponse, mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekWebSearchProvider } from "./web-search-provider.js";

const KEY = "deepseek-synthetic-search-key";
function searchTool(config: OpenClawConfig = {}, searchConfig: Record<string, unknown> = {}) {
  const tool = createDeepSeekWebSearchProvider().createTool({ config, searchConfig });
  if (!tool) {
    throw new Error("Expected DeepSeek search tool");
  }
  return tool;
}
function configKey(apiKey: unknown): OpenClawConfig {
  return { plugins: { entries: { deepseek: { config: { webSearch: { apiKey } } } } } };
}
function response() {
  return jsonResponse({
    results: [
      {
        title: "OpenClaw",
        url: "https://docs.openclaw.ai/",
        summary: "Model-oriented summary",
        snippet: "Short UI snippet",
        date: "2026-10-17T00:00:00+00:00",
        site_name: "OpenClaw docs",
        content: "Full content must not escape",
        authority: 3,
        rerank_score: 2.4,
      },
    ],
  });
}

describeWebSearchProviderContracts("deepseek");
describe("DeepSeek search execution", () => {
  beforeEach(() => {
    vi.stubEnv("DEEPSEEK_API_KEY", KEY);
    mockPinnedHostnameResolution();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends only the search request and maps model summaries without full content", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const query = 'OpenClaw site:github.com lang:en after:2026 "release notes"';
    const result = await searchTool().execute({ query, count: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    if (typeof init?.body !== "string") {
      throw new Error("Expected serialized search request body");
    }
    expect(JSON.parse(init.body)).toEqual({ query, count: 1, need_content: false });
    expect(result).toMatchObject({
      provider: "deepseek",
      count: 1,
      results: [
        {
          title: "OpenClaw",
          url: "https://docs.openclaw.ai/",
          snippet: "Model-oriented summary",
          published: "2026-10-17T00:00:00+00:00",
          siteName: "OpenClaw docs",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("Full content");
    expect(JSON.stringify(result)).not.toContain("rerank_score");
  });

  it.each([
    {
      name: "plugin key before env/model",
      config: configKey("plugin-key"),
      env: KEY,
      expected: "plugin-key",
    },
    {
      name: "env before model",
      config: {
        models: {
          providers: {
            deepseek: { apiKey: "model-key", baseUrl: "https://chat-proxy.example/v1", models: [] },
          },
        },
      },
      env: KEY,
      expected: KEY,
    },
    {
      name: "model fallback",
      config: {
        models: {
          providers: {
            deepseek: { apiKey: "model-key", baseUrl: "https://api.deepseek.com", models: [] },
          },
        },
      },
      env: undefined,
      expected: "model-key",
    },
  ])("resolves $name without inheriting a chat endpoint", async ({ config, env, expected }) => {
    vi.stubEnv("DEEPSEEK_API_KEY", env);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    await searchTool(config).execute({ query: `credential ${expected}` });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/v1/tools/search");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${expected}`,
    );
  });

  it("reports missing and unresolved credentials without network access", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
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
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const query = "🦞".repeat(128);
    await searchTool().execute({ query });
    const body = fetch.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected serialized search request body");
    }
    expect(JSON.parse(body).query).toBe(query);
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
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await expect(
      searchTool().execute({
        query: "unsupported filter",
        [key]: key === "domain_filter" ? ["example.com"] : "value",
      }),
    ).resolves.toMatchObject({ error: "unsupported_filter" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses shared count defaults/config and rejects invalid counts before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    vi.stubGlobal("fetch", fetch);
    await searchTool().execute({ query: "count defaults" });
    await searchTool({}, { maxResults: 2 }).execute({ query: "count configured" });
    await searchTool({}, { maxResults: 2 }).execute({ query: "count override", count: 10 });
    for (const count of [0, -1, 1.5, 11]) {
      await expect(searchTool().execute({ query: "invalid count", count })).rejects.toThrow(
        "count must be an integer",
      );
    }
    expect(
      fetch.mock.calls.map(([, init]) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected serialized search request body");
        }
        return JSON.parse(init.body).count;
      }),
    ).toEqual([5, 2, 10]);
  });

  it("caches empty results, partitions by count/key/query, and honors current TTL", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetch);
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
    await searchTool({}, { cacheTtlMinutes: 0 }).execute({ query });
    await searchTool({}, { cacheTtlMinutes: 0 }).execute({ query });
    expect(fetch).toHaveBeenCalledTimes(6);
    now.mockReturnValue(1_060_000);
    await searchTool({}, { cacheTtlMinutes: 1 }).execute({ query });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("falls back to UI snippets, preserves ordering, and caps returned rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse({
          results: [
            {
              title: "First",
              url: "https://one.example",
              summary: " ",
              snippet: "UI fallback",
              date: null,
              site_name: null,
            },
            { title: "Second", url: "https://two.example", summary: "Second summary" },
            { title: "Third", url: "https://three.example" },
          ],
        }),
      ),
    );
    const result = await searchTool().execute({ query: "fallback snippets", count: 2 });
    expect(result.results).toEqual([
      {
        title: "First",
        url: "https://one.example/",
        snippet: "UI fallback",
        published: undefined,
        siteName: undefined,
      },
      {
        title: "Second",
        url: "https://two.example/",
        snippet: "Second summary",
        published: undefined,
        siteName: undefined,
      },
    ]);
    expect(result.count).toBe(2);
  });

  it.each(["{ nope", "[]", "{}", '{"results":{}}'])(
    "rejects malformed response %s without caching",
    async (body) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(body))
        .mockResolvedValueOnce(response());
      vi.stubGlobal("fetch", fetch);
      const tool = searchTool();
      const query = `bad response ${body}`;
      await expect(tool.execute({ query })).rejects.toThrow("malformed JSON response");
      expect(await tool.execute({ query })).toMatchObject({ count: 1 });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([401, 402, 429, 500, 504])(
    "preserves HTTP %s, redacts reflected credentials, and does not retry/cache failure",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(`reflected Bearer ${KEY}`, { status }))
        .mockResolvedValueOnce(response());
      vi.stubGlobal("fetch", fetch);
      const tool = searchTool();
      const query = `http error ${status}`;
      const failure = await tool.execute({ query }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ status });
      expect(String(failure)).not.toContain(KEY);
      expect(fetch).toHaveBeenCalledOnce();
      expect(await tool.execute({ query })).toMatchObject({ count: 1 });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("cancels in-flight work and never caches a late response", async () => {
    let resolveResponse!: (response: Response) => void;
    const started = Promise.withResolvers<void>();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce((_url, init) => {
        started.resolve();
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve;
          expect(init?.signal).toBeDefined();
        });
      })
      .mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const tool = searchTool();
    const query = "late cancellation";
    const controller = new AbortController();
    const pending = tool.execute({ query }, { signal: controller.signal });
    await started.promise;
    const reason = new Error("DeepSeek caller cancelled");
    controller.abort(reason);
    resolveResponse(response());
    await expect(pending).rejects.toBe(reason);
    await tool.execute({ query });
    expect(fetch).toHaveBeenCalledTimes(2);
    const aborted = new AbortController();
    aborted.abort(reason);
    await expect(tool.execute({ query }, { signal: aborted.signal })).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
