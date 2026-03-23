import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TAVILY_BASE_URL,
  DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS,
  DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS,
  resolveTavilyApiKey,
  resolveTavilyBaseUrl,
  resolveTavilyExtractTimeoutSeconds,
  resolveTavilySearchConfig,
  resolveTavilySearchTimeoutSeconds,
} from "./config.js";

describe("tavily config helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads plugin web search config and prefers it over env defaults", () => {
    vi.stubEnv("TAVILY_API_KEY", "env-key");
    vi.stubEnv("TAVILY_BASE_URL", "https://env.tavily.test");

    const cfg = {
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: "plugin-key",
                baseUrl: "https://plugin.tavily.test",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveTavilySearchConfig(cfg)).toEqual({
      apiKey: "plugin-key",
      baseUrl: "https://plugin.tavily.test",
    });
    expect(resolveTavilyApiKey(cfg)).toBe("plugin-key");
    expect(resolveTavilyBaseUrl(cfg)).toBe("https://plugin.tavily.test");
  });

  it("falls back to environment values and defaults", () => {
    vi.stubEnv("TAVILY_API_KEY", "env-key");
    vi.stubEnv("TAVILY_BASE_URL", "https://env.tavily.test");

    expect(resolveTavilyApiKey()).toBe("env-key");
    expect(resolveTavilyBaseUrl()).toBe("https://env.tavily.test");
    expect(resolveTavilyBaseUrl({} as OpenClawConfig)).not.toBe(DEFAULT_TAVILY_BASE_URL);
    expect(resolveTavilySearchTimeoutSeconds()).toBe(DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS);
    expect(resolveTavilyExtractTimeoutSeconds()).toBe(DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS);
  });

  it("accepts positive numeric timeout overrides and floors them", () => {
    expect(resolveTavilySearchTimeoutSeconds(19.9)).toBe(19);
    expect(resolveTavilyExtractTimeoutSeconds(42.7)).toBe(42);
    expect(resolveTavilySearchTimeoutSeconds(0)).toBe(DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS);
    expect(resolveTavilyExtractTimeoutSeconds(Number.NaN)).toBe(
      DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS,
    );
  });
});
