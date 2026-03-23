import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FIRECRAWL_BASE_URL,
  DEFAULT_FIRECRAWL_MAX_AGE_MS,
  DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_SECONDS,
  DEFAULT_FIRECRAWL_SEARCH_TIMEOUT_SECONDS,
  resolveFirecrawlApiKey,
  resolveFirecrawlBaseUrl,
  resolveFirecrawlMaxAgeMs,
  resolveFirecrawlOnlyMainContent,
  resolveFirecrawlScrapeTimeoutSeconds,
  resolveFirecrawlSearchConfig,
  resolveFirecrawlSearchTimeoutSeconds,
} from "./config.js";

describe("firecrawl config helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers plugin webSearch config over legacy tool search config", () => {
    const cfg = {
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "plugin-key",
                baseUrl: "https://plugin.firecrawl.test",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            firecrawl: {
              apiKey: "legacy-key",
              baseUrl: "https://legacy.firecrawl.test",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveFirecrawlSearchConfig(cfg)).toEqual({
      apiKey: "plugin-key",
      baseUrl: "https://plugin.firecrawl.test",
    });
    expect(resolveFirecrawlApiKey(cfg)).toBe("plugin-key");
    expect(resolveFirecrawlBaseUrl(cfg)).toBe("https://plugin.firecrawl.test");
  });

  it("falls back to environment and defaults for fetch config values", () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "env-key");
    vi.stubEnv("FIRECRAWL_BASE_URL", "https://env.firecrawl.test");

    expect(resolveFirecrawlApiKey()).toBe("env-key");
    expect(resolveFirecrawlBaseUrl()).toBe("https://env.firecrawl.test");
    expect(resolveFirecrawlOnlyMainContent()).toBe(true);
    expect(resolveFirecrawlMaxAgeMs()).toBe(DEFAULT_FIRECRAWL_MAX_AGE_MS);
    expect(resolveFirecrawlScrapeTimeoutSeconds()).toBe(DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_SECONDS);
    expect(resolveFirecrawlSearchTimeoutSeconds()).toBe(DEFAULT_FIRECRAWL_SEARCH_TIMEOUT_SECONDS);
    expect(resolveFirecrawlBaseUrl({} as OpenClawConfig)).not.toBe(DEFAULT_FIRECRAWL_BASE_URL);
  });

  it("respects positive numeric overrides for scrape and cache behavior", () => {
    const cfg = {
      tools: {
        web: {
          fetch: {
            firecrawl: {
              onlyMainContent: false,
              maxAgeMs: 1234,
              timeoutSeconds: 42,
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveFirecrawlOnlyMainContent(cfg)).toBe(false);
    expect(resolveFirecrawlMaxAgeMs(cfg)).toBe(1234);
    expect(resolveFirecrawlMaxAgeMs(cfg, 77.9)).toBe(77);
    expect(resolveFirecrawlScrapeTimeoutSeconds(cfg)).toBe(42);
    expect(resolveFirecrawlScrapeTimeoutSeconds(cfg, 19.8)).toBe(19);
    expect(resolveFirecrawlSearchTimeoutSeconds(9.7)).toBe(9);
  });
});
