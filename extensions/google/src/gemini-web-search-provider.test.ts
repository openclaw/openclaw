import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../../test/helpers/plugins/env.js";
import { __testing, createGeminiWebSearchProvider } from "./gemini-web-search-provider.js";

const geminiApiKeyEnv = ["GEMINI_API", "KEY"].join("_");

describe("gemini web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("prefers scoped configured Gemini API keys over environment and provider fallbacks", () => {
    withEnv({ [geminiApiKeyEnv]: "gemini-env-secret" }, () => {
      expect(
        __testing.resolveGeminiApiKey(
          {
            apiKey: "gemini-secret",
          },
          {
            baseUrl: "https://example.com",
            apiKey: "provider-secret",
            models: [],
          },
        ),
      ).toBe("gemini-secret");
    });
  });

  it("falls back to GEMINI_API_KEY before models.providers.google.apiKey", () => {
    withEnv({ [geminiApiKeyEnv]: "gemini-env-secret" }, () => {
      expect(
        __testing.resolveGeminiApiKey(
          {},
          {
            baseUrl: "https://example.com",
            apiKey: "provider-secret",
            models: [],
          },
        ),
      ).toBe("gemini-env-secret");
    });
  });

  it("falls back to models.providers.google.apiKey when dedicated config is unset", () => {
    expect(
      __testing.resolveGeminiApiKey(
        {},
        {
          baseUrl: "https://example.com",
          apiKey: "provider-secret",
          models: [],
        },
      ),
    ).toBe("provider-secret");
  });

  it("prefers scoped Gemini baseUrl over models.providers.google.baseUrl", () => {
    expect(
      __testing.resolveGeminiBaseUrl(
        {
          baseUrl: "https://search-proxy.example.com/gemini",
        },
        {
          baseUrl: "https://generativelanguage.googleapis.com",
          models: [],
        },
      ),
    ).toBe("https://search-proxy.example.com/gemini");
  });

  it("falls back to models.providers.google.baseUrl and normalizes bare Google hosts", () => {
    expect(
      __testing.resolveGeminiBaseUrl(undefined, {
        baseUrl: "https://generativelanguage.googleapis.com",
        models: [],
      }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("falls back to the default Gemini model when unset or blank", () => {
    expect(__testing.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(__testing.resolveGeminiModel({ model: "  " })).toBe("gemini-2.5-flash");
    expect(__testing.resolveGeminiModel({ model: "gemini-2.5-pro" })).toBe("gemini-2.5-pro");
  });

  it("exposes models.providers.google.apiKey to configured credential lookup for auto-detect", () => {
    const provider = createGeminiWebSearchProvider();

    expect(
      provider.getConfiguredCredentialValue?.({
        models: {
          providers: {
            google: {
              apiKey: "provider-secret",
              baseUrl: "https://example.com",
              models: [],
            },
          },
        },
      } as never),
    ).toBe("provider-secret");
  });

  it("prefers dedicated Gemini web search config over models.providers.google.apiKey for auto-detect", () => {
    const provider = createGeminiWebSearchProvider();

    expect(
      provider.getConfiguredCredentialValue?.({
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "scoped-secret",
                },
              },
            },
          },
        },
        models: {
          providers: {
            google: {
              apiKey: "provider-secret",
              baseUrl: "https://example.com",
              models: [],
            },
          },
        },
      } as never),
    ).toBe("scoped-secret");
  });

  it("returns a missing-key error when no dedicated, env, or provider fallback exists", async () => {
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {},
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw",
    });

    expect(result).toMatchObject({
      error: "missing_gemini_api_key",
    });
    expect(result).toMatchObject({
      message: expect.stringContaining("models.providers.google.apiKey"),
    });
  });

  it("uses models.providers.google apiKey and baseUrl fallback at execution time", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: "grounded answer" }],
            },
          },
        ],
      }),
    });
    global.fetch = fetchMock as typeof global.fetch;

    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        models: {
          providers: {
            google: {
              apiKey: "provider-secret",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: [],
            },
          },
        },
      },
      searchConfig: {},
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-goog-api-key": "provider-secret",
        }),
      }),
    );
    expect(result).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
  });
});
