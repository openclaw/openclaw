// Perplexity tests cover perplexity web search provider plugin behavior.
import { withEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createPerplexityWebSearchProvider } from "./perplexity-web-search-provider.js";
import { testing } from "./perplexity-web-search-provider.runtime.js";

const openRouterApiKeyEnv = ["OPENROUTER_API", "KEY"].join("_");
const perplexityApiKeyEnv = ["PERPLEXITY_API", "KEY"].join("_");
const openRouterPerplexityApiKey = ["sk", "or", "v1", "test"].join("-");
const directPerplexityApiKey = ["pplx", "test"].join("-");
const enterprisePerplexityApiKey = ["enterprise", "perplexity", "test"].join("-");

const runtimeMetadata = (perplexityTransport: "chat_completions" | "search_api") => ({
  providerSource: "configured" as const,
  selectedProvider: "perplexity",
  perplexityTransport,
  diagnostics: [],
});

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
            "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
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

  it("advertises search_context_size only for chat-completions transports", () => {
    const provider = createPerplexityWebSearchProvider();
    const chatTool = provider.createTool({
      config: {},
      searchConfig: {},
      runtimeMetadata: runtimeMetadata("chat_completions"),
    });
    const searchApiTool = provider.createTool({
      config: {},
      searchConfig: {},
      runtimeMetadata: runtimeMetadata("search_api"),
    });

    if (!chatTool || !searchApiTool) {
      throw new Error("Expected Perplexity web search tools");
    }

    const chatParameters = chatTool.parameters as {
      properties?: { search_context_size?: { enum?: unknown; type?: unknown } };
    };
    const searchApiParameters = searchApiTool.parameters as {
      properties?: { search_context_size?: unknown };
    };

    expect(chatParameters.properties?.search_context_size).toMatchObject({
      type: "string",
      enum: ["low", "medium", "high"],
    });
    expect(searchApiParameters.properties?.search_context_size).toBeUndefined();
  });

  it("forwards search_context_size through Perplexity chat completions", () => {
    expect(
      testing.buildPerplexityChatCompletionsBody({
        query: "OpenClaw",
        baseUrl: "https://api.perplexity.ai",
        model: "perplexity/sonar-pro",
        searchContextSize: "high",
      }),
    ).toMatchObject({
      model: "sonar-pro",
      messages: [{ role: "user", content: "OpenClaw" }],
      web_search_options: { search_context_size: "high" },
    });
  });

  it("rejects search_context_size on native Search API transport before network calls", async () => {
    await withEnvAsync(
      { [perplexityApiKeyEnv]: directPerplexityApiKey, [openRouterApiKeyEnv]: undefined },
      async () => {
        const provider = createPerplexityWebSearchProvider();
        const tool = provider.createTool({ config: {}, searchConfig: {} });
        if (!tool) {
          throw new Error("Expected tool definition");
        }

        await expect(
          tool.execute({ query: "OpenClaw docs", search_context_size: "high" }),
        ).resolves.toEqual({
          error: "unsupported_search_context_size",
          message:
            "search_context_size is only supported by the Perplexity Sonar chat-completions path. Configure a Perplexity baseUrl/model override or use an OPENROUTER_API_KEY to enable it.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      },
    );
  });

  it("validates search_context_size values", () => {
    expect(testing.readPerplexitySearchContextSize({ search_context_size: "HIGH" })).toBe("high");
    expect(testing.readPerplexitySearchContextSize({ search_context_size: "deep" })).toEqual({
      error: "invalid_search_context_size",
    });
  });
});
