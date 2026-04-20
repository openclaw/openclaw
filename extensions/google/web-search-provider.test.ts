import { withEnv } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { __testing, createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

describe("google web search provider", () => {
  it("falls back to GEMINI_API_KEY from the environment", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(__testing.resolveGeminiApiKey()).toBe("AIza-env-test");
    });
  });

  it("prefers configured api keys over env fallbacks", () => {
    withEnv({ GEMINI_API_KEY: "AIza-env-test" }, () => {
      expect(__testing.resolveGeminiApiKey({ apiKey: "AIza-configured-test" })).toBe(
        "AIza-configured-test",
      );
    });
  });

  it("stores configured credentials at the canonical plugin config path", () => {
    const provider = createGeminiWebSearchProvider();
    const config = {} as OpenClawConfig;

    provider.setConfiguredCredentialValue?.(config, "AIza-plugin-test");

    expect(provider.credentialPath).toBe("plugins.entries.google.config.webSearch.apiKey");
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("AIza-plugin-test");
  });

  it("defaults the Gemini web search model and trims explicit overrides", () => {
    expect(__testing.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(__testing.resolveGeminiModel({ model: "  gemini-2.5-pro  " })).toBe("gemini-2.5-pro");
  });

  it("resolves the Gemini base URL from config and environment", () => {
    withEnv(
      {
        GEMINI_BASE_URL: "https://custom.gemini.api/v1",
        GOOGLE_GEMINI_BASE_URL: undefined,
        GOOGLE_GEMINI_ENDPOINT: undefined,
      },
      () => {
        expect(__testing.resolveGeminiBaseUrl()).toBe("https://custom.gemini.api/v1");
        expect(__testing.resolveGeminiBaseUrl({ baseUrl: "https://override.api" })).toBe(
          "https://override.api",
        );
      },
    );
  });

  it("auto-detects OpenAI-compatible API type based on base URL", () => {
    expect(__testing.resolveGeminiApiType({ baseUrl: "https://api.groq.com/openai/v1" })).toBe(
      "openai-compatible",
    );
    expect(__testing.resolveGeminiApiType({ baseUrl: "https://generativelanguage.googleapis.com" })).toBe(
      "gemini",
    );
  });

  it("respects explicit API type overrides", () => {
    expect(__testing.resolveGeminiApiType({ apiType: "openai-compatible" })).toBe(
      "openai-compatible",
    );
    withEnv({ GEMINI_API_TYPE: "openai-compatible" }, () => {
      expect(__testing.resolveGeminiApiType()).toBe("openai-compatible");
    });
  });
});
