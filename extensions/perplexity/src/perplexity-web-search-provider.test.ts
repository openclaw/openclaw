// Perplexity tests cover perplexity web search provider plugin behavior.
import { withEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";

const withTrustedWebSearchEndpointMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...actual,
    withTrustedWebSearchEndpoint: withTrustedWebSearchEndpointMock,
  };
});

import { createPerplexityWebSearchProvider } from "./perplexity-web-search-provider.js";
import { testing } from "./perplexity-web-search-provider.runtime.js";

const openRouterApiKeyEnv = ["OPENROUTER_API", "KEY"].join("_");
const perplexityApiKeyEnv = ["PERPLEXITY_API", "KEY"].join("_");
const openRouterPerplexityApiKey = ["sk", "or", "v1", "test"].join("-");
const directPerplexityApiKey = ["pplx", "test"].join("-");
const enterprisePerplexityApiKey = ["enterprise", "perplexity", "test"].join("-");

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("perplexity web search provider", () => {
  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await expect(tool.execute({ query: "OpenClaw docs" })).resolves.toEqual({
          error: "missing_perplexity_api_key",
          message:
            "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure plugins.entries.perplexity.config.webSearch.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      },
    );
  });

  it("infers provider routing from api key prefixes", () => {
    expect(testing.inferPerplexityBaseUrlFromApiKey("pplx-abc")).toBe("direct");
    expect(testing.inferPerplexityBaseUrlFromApiKey("sk-or-v1-abc")).toBe("openrouter");
    expect(testing.inferPerplexityBaseUrlFromApiKey("unknown")).toBeUndefined();
  });

  it("resolves base url from auth source and request model by transport", () => {
    expect(testing.resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe(
      "https://api.perplexity.ai",
    );
    expect(testing.resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(
      testing.resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro"),
    ).toBe("sonar-pro");
    expect(
      testing.resolvePerplexityRequestModel("https://openrouter.ai/api/v1", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
  });

  it("chooses direct search_api transport only for direct base urls without legacy overrides", () => {
    expect(
      testing.resolvePerplexityTransport({
        baseUrl: "https://api.perplexity.ai",
      }).transport,
    ).toBe("chat_completions");

    expect(
      testing.resolvePerplexityTransport({
        apiKey: "pplx-secret",
      }).transport,
    ).toBe("search_api");
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(
      testing.resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123"),
    ).toBe("https://example.com");
  });

  it("resolves OpenRouter env auth and transport", () => {
    withEnv(
      { [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: openRouterPerplexityApiKey },
      () => {
        expect(testing.resolvePerplexityApiKey(undefined)).toEqual({
          apiKey: openRouterPerplexityApiKey,
          source: "openrouter_env",
        });
        expect(testing.resolvePerplexityTransport(undefined)).toEqual({
          apiKey: openRouterPerplexityApiKey,
          source: "openrouter_env",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
          transport: "chat_completions",
        });
      },
    );
  });

  it("uses native Search API for direct Perplexity when no legacy overrides exist", () => {
    withEnv(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      () => {
        expect(testing.resolvePerplexityTransport(undefined)).toEqual({
          apiKey: directPerplexityApiKey,
          source: "perplexity_env",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
          transport: "search_api",
        });
      },
    );
  });

  it("switches direct Perplexity to chat completions when model override is configured", () => {
    expect(testing.resolvePerplexityModel({ model: "perplexity/sonar-reasoning-pro" })).toBe(
      "perplexity/sonar-reasoning-pro",
    );
    expect(
      testing.resolvePerplexityTransport({
        apiKey: directPerplexityApiKey,
        model: "perplexity/sonar-reasoning-pro",
      }),
    ).toEqual({
      apiKey: directPerplexityApiKey,
      source: "config",
      baseUrl: "https://api.perplexity.ai",
      model: "perplexity/sonar-reasoning-pro",
      transport: "chat_completions",
    });
  });

  it("treats unrecognized configured keys as direct Perplexity by default", () => {
    expect(
      testing.resolvePerplexityTransport({
        apiKey: enterprisePerplexityApiKey,
      }),
    ).toEqual({
      apiKey: enterprisePerplexityApiKey,
      source: "config",
      baseUrl: "https://api.perplexity.ai",
      model: "perplexity/sonar-pro",
      transport: "search_api",
    });
  });

  it("sends official date filter fields in the Search API request body", async () => {
    withTrustedWebSearchEndpointMock.mockImplementationOnce(
      async (_params: { init: RequestInit }, run: (response: Response) => Promise<unknown>) =>
        await run(
          new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );

    await withEnvAsync(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await tool.execute({
          query: "OpenClaw releases",
          date_after: "2024-01-01",
          date_before: "2024-06-30",
        });
      },
    );

    expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledOnce();
    const [request] = withTrustedWebSearchEndpointMock.mock.calls[0] as [{ init: RequestInit }];
    expect(JSON.parse(request.init.body as string)).toEqual({
      query: "OpenClaw releases",
      max_results: 5,
      search_after_date_filter: "1/1/2024",
      search_before_date_filter: "6/30/2024",
    });
  });

  it("advertises search_context_size in native and chat schemas", () => {
    const provider = createPerplexityWebSearchProvider();
    const nativeTool = provider.createTool({ config: {}, searchConfig: {} });
    const chatTool = provider.createTool({
      config: {},
      searchConfig: {},
      runtimeMetadata: {
        providerSource: "configured",
        diagnostics: [],
        perplexityTransport: "chat_completions",
      },
    });
    const nativeParameters = nativeTool?.parameters as
      | { properties?: Record<string, { enum?: unknown; type?: unknown }> }
      | undefined;
    const chatParameters = chatTool?.parameters as
      | { properties?: Record<string, { enum?: unknown; type?: unknown }> }
      | undefined;

    expect(nativeParameters?.properties?.search_context_size).toMatchObject({
      type: "string",
      enum: ["low", "medium", "high"],
    });
    expect(chatParameters?.properties?.search_context_size).toMatchObject({
      type: "string",
      enum: ["low", "medium", "high"],
    });
    expect(chatParameters?.properties?.max_tokens).toBeUndefined();
  });

  it("rejects invalid search_context_size values before network calls", async () => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await expect(
          tool.execute({ query: "OpenClaw docs", search_context_size: "huge" }),
        ).resolves.toEqual({
          error: "invalid_search_context_size",
          message: "search_context_size must be low, medium, or high.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      },
    );
  });

  it("rejects mixed native content budget controls", async () => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await expect(
          tool.execute({
            query: "OpenClaw docs",
            search_context_size: "low",
            max_tokens: 1000,
          }),
        ).resolves.toEqual({
          error: "conflicting_content_budget",
          message:
            "search_context_size cannot be used with max_tokens or max_tokens_per_page. Use either search_context_size or explicit token budgets, not both.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      },
    );
  });

  it("sends search_context_size to the native Search API and caches by value", async () => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        const previousFetch = globalThis.fetch;
        const bodies: Array<Record<string, unknown>> = [];
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(parseRequestBody(init));
          return new Response(
            JSON.stringify({
              results: [{ title: "OpenClaw", url: "https://openclaw.ai", snippet: "Docs" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        try {
          const query = `OpenClaw search context native ${Date.now()}`;
          await tool.execute({ query, search_context_size: "low" });
          await tool.execute({ query, search_context_size: "high" });
        } finally {
          globalThis.fetch = previousFetch;
        }

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(bodies.map((body) => body.search_context_size)).toEqual(["low", "high"]);
      },
    );
  });

  it("sends search_context_size through Sonar compatibility web_search_options", async () => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: undefined, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({
          config: {},
          searchConfig: {
            perplexity: {
              apiKey: directPerplexityApiKey,
              model: "perplexity/sonar-pro",
            },
          },
        });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        const previousFetch = globalThis.fetch;
        const bodies: Array<Record<string, unknown>> = [];
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(parseRequestBody(init));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "OpenClaw answer",
                    annotations: [
                      {
                        type: "url_citation",
                        url_citation: { url: "https://openclaw.ai" },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        try {
          await tool.execute({
            query: `OpenClaw search context chat ${Date.now()}`,
            search_context_size: "MEDIUM",
          });
        } finally {
          globalThis.fetch = previousFetch;
        }

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(bodies[0]?.web_search_options).toEqual({ search_context_size: "medium" });
      },
    );
  });

  it.each([
    ["max_tokens", 0, "max_tokens must be a positive integer."],
    ["max_tokens", 1.5, "max_tokens must be a positive integer."],
    ["max_tokens", 1_000_001, "max_tokens must be a positive integer."],
    ["max_tokens_per_page", 1.5, "max_tokens_per_page must be a positive integer."],
  ])("rejects invalid native token budget %s=%s", async (key, value, message) => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await expect(tool.execute({ query: "OpenClaw docs", [key]: value })).rejects.toThrow(
          message,
        );
      },
    );
  });

  it("reports malformed Search API JSON with a stable provider error", async () => {
    await expect(
      testing.readPerplexityJsonResponse(new Response("{ nope"), "Perplexity Search"),
    ).rejects.toThrow("Perplexity Search: malformed JSON response");
  });

  it("reports malformed chat completion JSON with a stable provider error", async () => {
    await expect(
      testing.readPerplexityJsonResponse(new Response("{ nope"), "Perplexity"),
    ).rejects.toThrow("Perplexity: malformed JSON response");
  });

  it("bounds successful Perplexity JSON bodies before parsing", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const jsonSpy = vi.spyOn(streamed.response, "json").mockRejectedValue(new Error("unbounded"));

    await expect(
      testing.readPerplexityJsonResponse(streamed.response, "Perplexity Search"),
    ).rejects.toThrow("Perplexity Search: JSON response exceeds 16777216 bytes");

    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(jsonSpy).not.toHaveBeenCalled();
  });
});
