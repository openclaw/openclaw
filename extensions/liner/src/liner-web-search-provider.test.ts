import { beforeEach, describe, expect, it, vi } from "vitest";

type EndpointCall = {
  url: string;
  timeoutSeconds: number;
  init: RequestInit;
};

const endpointMockState = vi.hoisted(() => ({
  calls: [] as EndpointCall[],
  responses: [] as Response[],
}));

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  const runEndpoint = async (
    params: EndpointCall,
    run: (response: Response) => Promise<unknown>,
  ) => {
    endpointMockState.calls.push(params);
    const response = endpointMockState.responses.shift();
    if (!response) {
      throw new Error("Missing mocked Liner response.");
    }
    return await run(response);
  };
  return {
    ...actual,
    withTrustedWebSearchEndpoint: vi.fn(runEndpoint),
  };
});

function readMockedBody(call: EndpointCall | undefined): unknown {
  if (!call || typeof call.init.body !== "string") {
    throw new Error("Expected mocked Liner request to carry a JSON string body.");
  }
  return JSON.parse(call.init.body);
}

import { testing } from "../test-api.js";
import { createLinerWebSearchProvider as createContractLinerWebSearchProvider } from "../web-search-contract-api.js";
import { createLinerWebSearchProvider } from "./liner-web-search-provider.js";

describe("liner web search provider", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [];
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createLinerWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("liner");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(provider.credentialPath).toBe("plugins.entries.liner.config.webSearch.apiKey");
    const pluginEntry = applied.plugins?.entries?.liner;
    if (!pluginEntry) {
      throw new Error("expected Liner plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createLinerWebSearchProvider();
    const contractProvider = createContractLinerWebSearchProvider();
    if (!contractProvider.applySelectionConfig) {
      throw new Error("Expected contract applySelectionConfig to be defined");
    }
    const applied = contractProvider.applySelectionConfig({});

    expect({
      id: contractProvider.id,
      label: contractProvider.label,
      hint: contractProvider.hint,
      onboardingScopes: contractProvider.onboardingScopes,
      credentialLabel: contractProvider.credentialLabel,
      envVars: contractProvider.envVars,
      placeholder: contractProvider.placeholder,
      signupUrl: contractProvider.signupUrl,
      docsUrl: contractProvider.docsUrl,
      autoDetectOrder: contractProvider.autoDetectOrder,
      credentialPath: contractProvider.credentialPath,
    }).toEqual({
      id: provider.id,
      label: provider.label,
      hint: provider.hint,
      onboardingScopes: provider.onboardingScopes,
      credentialLabel: provider.credentialLabel,
      envVars: provider.envVars,
      placeholder: provider.placeholder,
      signupUrl: provider.signupUrl,
      docsUrl: provider.docsUrl,
      autoDetectOrder: provider.autoDetectOrder,
      credentialPath: provider.credentialPath,
    });
    expect(contractProvider.createTool({ config: {}, searchConfig: {} })).toBeNull();
    const pluginEntry = applied.plugins?.entries?.liner;
    if (!pluginEntry) {
      throw new Error("expected contract Liner plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(testing.resolveLinerApiKey({ apiKey: "sk_live_secret" })).toBe("sk_live_secret");
  });

  it("resolves Liner search base URL overrides", () => {
    expect(testing.resolveLinerSearchEndpoint()).toEqual({
      endpoint: "https://platform.liner.com/api/v1/search/web",
    });
    expect(
      testing.resolveLinerSearchEndpoint({ baseUrl: "https://proxy.example/liner" }),
    ).toEqual({
      endpoint: "https://proxy.example/liner/api/v1/search/web",
    });
    expect(
      testing.resolveLinerSearchEndpoint({ baseUrl: "proxy.example/liner/api/v1/search/web/" }),
    ).toEqual({
      endpoint: "https://proxy.example/liner/api/v1/search/web",
    });
    expect(testing.resolveLinerSearchEndpoint({ baseUrl: "ftp://proxy.example/liner" })).toEqual({
      docs: "https://docs.openclaw.ai/tools/liner-search",
      error: "invalid_base_url",
      message:
        "plugins.entries.liner.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/liner",
    });
  });

  it("partitions Liner cache keys by resolved endpoint, query, and count", () => {
    const base = { query: "openclaw github", count: 5 };
    expect(
      testing.buildLinerCacheKey({ ...base, endpoint: "https://platform.liner.com/api/v1/search/web" }),
    ).not.toBe(testing.buildLinerCacheKey({ ...base, endpoint: "https://proxy.example/api/v1/search/web" }));
    const endpoint = "https://platform.liner.com/api/v1/search/web";
    expect(testing.buildLinerCacheKey({ endpoint, query: "a", count: 5 })).not.toBe(
      testing.buildLinerCacheKey({ endpoint, query: "b", count: 5 }),
    );
    expect(testing.buildLinerCacheKey({ endpoint, query: "a", count: 5 })).not.toBe(
      testing.buildLinerCacheKey({ endpoint, query: "a", count: 10 }),
    );
  });

  it("normalizes the Liner response shape", () => {
    expect(
      testing.normalizeLinerResults({
        results: [
          { url: "https://example.com/a", title: "Sample", description: "excerpt", date: "2026-04-01" },
          "not-an-object",
        ],
      }),
    ).toEqual([
      { url: "https://example.com/a", title: "Sample", description: "excerpt", date: "2026-04-01" },
    ]);
    expect(testing.normalizeLinerResults({})).toEqual([]);
    expect(testing.normalizeLinerResults(null)).toEqual([]);
  });

  it("maps Liner results into wrapped web_search entries (description -> description, date -> published)", () => {
    const mapped = testing.mapLinerResults({
      results: [
        {
          title: "Liner",
          url: "https://liner.com/",
          description: "AI search assistant",
          date: "2025-09-20",
        },
        { title: "No URL", description: "dropped" },
      ],
    });
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      url: "https://liner.com/",
      published: "2025-09-20",
    });
    expect(String(mapped[0].title)).toContain("Liner");
    expect(String(mapped[0].description)).toContain("AI search assistant");
  });

  it("clamps Liner result counts to the documented 1-50 range", () => {
    expect(testing.resolveLinerSearchCount(5)).toBe(5);
    expect(testing.resolveLinerSearchCount(120)).toBe(50);
    expect(testing.resolveLinerSearchCount(0)).toBe(1);
  });

  it("returns a stable missing-key payload that points at the real config path", () => {
    expect(testing.missingLinerKeyPayload()).toEqual({
      error: "missing_liner_api_key",
      message:
        "web_search (liner) needs a Liner API key. Set LINER_API_KEY in the Gateway environment, or configure plugins.entries.liner.config.webSearch.apiKey.",
      docs: "https://docs.openclaw.ai/tools/liner-search",
    });
  });

  it("identifies the plugin via a versioned User-Agent header", () => {
    expect(testing.USER_AGENT).toMatch(/^openclaw-liner\/\d+\.\d+\.\d+/);
  });

  it("returns an error payload when query is missing or empty", async () => {
    const provider = createLinerWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { liner: { apiKey: "sk_live_secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    expect(await tool.execute({})).toMatchObject({ error: "invalid_query" });
    expect(await tool.execute({ query: "   " })).toMatchObject({ error: "invalid_query" });
    expect(endpointMockState.calls).toHaveLength(0);
  });

  it("sends query + max_results with the API key header and maps the response", async () => {
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          requestId: "req-1",
          totalCount: 1,
          results: [
            { title: "A", url: "https://example.com/a", description: "alpha", date: null },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createLinerWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { liner: { apiKey: "sk_live_secret" }, maxResults: 3, timeoutSeconds: 5 },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = (await tool.execute({ query: "liner ai search" })) as Record<string, unknown>;

    expect(endpointMockState.calls).toHaveLength(1);
    const [call] = endpointMockState.calls;
    expect(call.url).toBe("https://platform.liner.com/api/v1/search/web");
    expect(call.timeoutSeconds).toBe(5);
    expect(readMockedBody(call)).toEqual({ query: "liner ai search", max_results: 3 });
    const headers = (call.init.headers ?? {}) as Record<string, string>;
    expect(headers["X-API-KEY"]).toBe("sk_live_secret");
    expect(headers["User-Agent"]).toMatch(/^openclaw-liner\//);
    expect(result).toMatchObject({ provider: "liner", requestId: "req-1", count: 1 });
  });

  it("always sends max_results matching the OpenClaw web_search default when no count is provided", async () => {
    endpointMockState.responses.push(
      new Response(JSON.stringify({ requestId: "x", totalCount: 0, results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createLinerWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { liner: { apiKey: "sk_live_secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await tool.execute({ query: "openclaw" });
    const body = readMockedBody(endpointMockState.calls[0]) as { max_results?: number };
    expect(body.max_results).toBe(5);
  });

  it("serves identical queries from the cache without a second HTTP call", async () => {
    const query = `liner-cache-${Date.now()}-${Math.random()}`;
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          requestId: "first",
          totalCount: 1,
          results: [{ title: "A", url: "https://example.com/a", description: "alpha" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createLinerWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { liner: { apiKey: "sk_live_secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const first = (await tool.execute({ query })) as { requestId?: string };
    const second = (await tool.execute({ query })) as { requestId?: string };
    expect(endpointMockState.calls).toHaveLength(1);
    expect(second.requestId).toBe(first.requestId);
  });
});
