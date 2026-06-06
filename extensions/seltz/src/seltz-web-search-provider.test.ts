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
      throw new Error("Missing mocked Seltz response.");
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
    throw new Error("Expected mocked Seltz request to carry a JSON string body.");
  }
  return JSON.parse(call.init.body);
}

import { testing } from "../test-api.js";
import { createSeltzWebSearchProvider as createContractSeltzWebSearchProvider } from "../web-search-contract-api.js";
import { createSeltzWebSearchProvider } from "./seltz-web-search-provider.js";

describe("seltz web search provider", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [];
  });

  it("exposes the expected metadata and selection wiring", () => {
    const provider = createSeltzWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("seltz");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(provider.credentialPath).toBe("plugins.entries.seltz.config.webSearch.apiKey");
    expect(provider.envVars).toEqual(["SELTZ_API_KEY"]);
    expect(provider.autoDetectOrder).toBe(80);
    const pluginEntry = applied.plugins?.entries?.seltz;
    if (!pluginEntry) {
      throw new Error("expected Seltz plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createSeltzWebSearchProvider();
    const contractProvider = createContractSeltzWebSearchProvider();
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
    const pluginEntry = applied.plugins?.entries?.seltz;
    if (!pluginEntry) {
      throw new Error("expected contract Seltz plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(testing.resolveSeltzApiKey({ apiKey: "seltz-secret" })).toBe("seltz-secret");
  });

  it("resolves Seltz search base URL overrides", () => {
    expect(testing.resolveSeltzSearchEndpoint()).toEqual({
      endpoint: "https://api.seltz.ai/v1/search",
    });
    expect(testing.resolveSeltzSearchEndpoint({ baseUrl: "https://proxy.example/seltz" })).toEqual({
      endpoint: "https://proxy.example/seltz/v1/search",
    });
    expect(
      testing.resolveSeltzSearchEndpoint({ baseUrl: "proxy.example/seltz/v1/search/" }),
    ).toEqual({
      endpoint: "https://proxy.example/seltz/v1/search",
    });
    expect(testing.resolveSeltzSearchEndpoint({ baseUrl: "ftp://proxy.example/seltz" })).toEqual({
      docs: "https://docs.openclaw.ai/tools/seltz-search",
      error: "invalid_base_url",
      message:
        "plugins.entries.seltz.config.webSearch.baseUrl must be a valid http(s) URL. Got: ftp://proxy.example/seltz",
    });
  });

  it("partitions Seltz cache keys by endpoint, query, and count", () => {
    const base = {
      endpoint: "https://api.seltz.ai/v1/search",
      query: "openclaw github",
      count: 5,
    };
    expect(testing.buildSeltzCacheKey(base)).not.toBe(
      testing.buildSeltzCacheKey({ ...base, endpoint: "https://proxy.example/seltz/v1/search" }),
    );
    expect(testing.buildSeltzCacheKey(base)).not.toBe(
      testing.buildSeltzCacheKey({ ...base, query: "openclaw release notes" }),
    );
    expect(testing.buildSeltzCacheKey(base)).not.toBe(
      testing.buildSeltzCacheKey({ ...base, count: 10 }),
    );
  });

  it("normalizes queries by trimming blanks", () => {
    expect(testing.normalizeSeltzQuery("  OpenClaw GitHub  ")).toBe("OpenClaw GitHub");
    expect(testing.normalizeSeltzQuery(undefined)).toBeUndefined();
    expect(testing.normalizeSeltzQuery("")).toBeUndefined();
    expect(testing.normalizeSeltzQuery("   ")).toBeUndefined();
  });

  it("normalizes the Seltz /v1/search response document shape", () => {
    expect(
      testing.normalizeSeltzResults({
        documents: [
          {
            url: "https://example.com/a",
            content: "sample content",
            publishedDate: "2026-04-01",
          },
          { content: "missing url" },
          "not-an-object",
        ],
      }),
    ).toEqual([
      {
        url: "https://example.com/a",
        content: "sample content",
        publishedDate: "2026-04-01",
      },
    ]);
    expect(testing.normalizeSeltzResults({})).toEqual([]);
    expect(testing.normalizeSeltzResults(null)).toEqual([]);
  });

  it("returns stable setup error payloads", () => {
    expect(testing.missingSeltzKeyPayload()).toEqual({
      error: "missing_seltz_api_key",
      message:
        "web_search (seltz) needs a Seltz API key. Set SELTZ_API_KEY in the Gateway environment, or configure plugins.entries.seltz.config.webSearch.apiKey.",
      docs: "https://docs.openclaw.ai/tools/seltz-search",
    });
    expect(testing.invalidQueryPayload()).toEqual({
      error: "invalid_query",
      message: "query must be a non-empty search string.",
      docs: "https://docs.openclaw.ai/tools/seltz-search",
    });
  });

  it("identifies the plugin via a versioned User-Agent header", () => {
    expect(testing.USER_AGENT).toMatch(/^openclaw-seltz\/\d+\.\d+\.\d+/);
  });

  it("returns an error payload when query is missing or empty", async () => {
    const provider = createSeltzWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { seltz: { apiKey: "seltz-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    expect(await tool.execute({})).toMatchObject({ error: "invalid_query" });
    expect(await tool.execute({ query: " " })).toMatchObject({ error: "invalid_query" });
    expect(endpointMockState.calls).toHaveLength(0);
  });

  it("sends the documented Seltz REST payload shape", async () => {
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          documents: [
            {
              url: "https://example.com/a",
              content: "alpha",
              publishedDate: "2026-04-01",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createSeltzWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        seltz: { apiKey: "seltz-secret" },
        maxResults: 3,
        timeoutSeconds: 5,
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({
      query: "OpenClaw GitHub",
    });

    expect(endpointMockState.calls).toHaveLength(1);
    const [call] = endpointMockState.calls;
    expect(call.url).toBe("https://api.seltz.ai/v1/search");
    expect(call.timeoutSeconds).toBe(5);
    expect(readMockedBody(call)).toEqual({
      query: "OpenClaw GitHub",
      max_results: 3,
    });
    const headers = (call.init.headers ?? {}) as Record<string, string>;
    expect(headers["x-api-key"]).toBe("seltz-secret");
    expect(headers["User-Agent"]).toMatch(/^openclaw-seltz\//);
    expect(result).toMatchObject({
      query: "OpenClaw GitHub",
      provider: "seltz",
      count: 1,
      results: [
        {
          title: expect.stringContaining("example.com"),
          url: "https://example.com/a",
          description: expect.stringContaining("alpha"),
          siteName: "example.com",
          published: "2026-04-01",
        },
      ],
    });
  });

  it("uses OpenClaw's default result count when no count is provided", async () => {
    endpointMockState.responses.push(
      new Response(JSON.stringify({ documents: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createSeltzWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { seltz: { apiKey: "seltz-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await tool.execute({ query: `seltz-default-count-${Date.now()}` });
    expect(readMockedBody(endpointMockState.calls[0])).toMatchObject({
      max_results: 5,
    });
  });

  it("clamps requested count through the shared web search limit", async () => {
    endpointMockState.responses.push(
      new Response(JSON.stringify({ documents: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createSeltzWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { seltz: { apiKey: "seltz-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await tool.execute({ query: `seltz-clamp-${Date.now()}`, count: 99 });
    expect(readMockedBody(endpointMockState.calls[0])).toMatchObject({
      max_results: 10,
    });
  });

  it("caches identical Seltz searches", async () => {
    const query = `seltz-cache-${Date.now()}-${Math.random()}`;
    endpointMockState.responses.push(
      new Response(
        JSON.stringify({
          documents: [{ url: "https://example.com/a", content: "alpha" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createSeltzWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { seltz: { apiKey: "seltz-secret" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    await tool.execute({ query });
    const cached = await tool.execute({ query });
    expect(endpointMockState.calls).toHaveLength(1);
    expect(cached).toMatchObject({
      provider: "seltz",
      results: [
        {
          url: "https://example.com/a",
          description: expect.stringContaining("alpha"),
        },
      ],
    });
  });
});
