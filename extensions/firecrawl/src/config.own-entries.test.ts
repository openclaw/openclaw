import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Tests verify that legacy nested Firecrawl entries respect own-property
// boundaries — inherited prototype properties are not treated as user config.
import { describe, expect, it } from "vitest";
import {
  resolveFirecrawlSearchConfig,
  resolveFirecrawlApiKey,
  resolveFirecrawlBaseUrl,
  resolveFirecrawlOnlyMainContent,
  resolveFirecrawlMaxAgeMs,
  resolveFirecrawlScrapeTimeoutSeconds,
} from "./config.js";

describe("firecrawl nested config own-property checks", () => {
  it("reads own firecrawl entry from tools.web.search", () => {
    const cfg = {
      tools: {
        web: {
          search: {
            firecrawl: { apiKey: "own-search-key", baseUrl: "https://own-search.test" },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveFirecrawlSearchConfig(cfg)).toEqual({
      apiKey: "own-search-key",
      baseUrl: "https://own-search.test",
    });
    expect(resolveFirecrawlApiKey(cfg)).toBe("own-search-key");
    expect(resolveFirecrawlBaseUrl(cfg)).toBe("https://own-search.test");
  });

  it("reads own firecrawl entry from tools.web.fetch", () => {
    const cfg = {
      tools: {
        web: {
          fetch: {
            firecrawl: {
              onlyMainContent: false,
              maxAgeMs: 99999,
              timeoutSeconds: 55,
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveFirecrawlOnlyMainContent(cfg)).toBe(false);
    expect(resolveFirecrawlMaxAgeMs(cfg)).toBe(99999);
    expect(resolveFirecrawlScrapeTimeoutSeconds(cfg)).toBe(55);
  });

  it("ignores inherited firecrawl property from tools.web.search prototype", () => {
    const search = Object.create({
      firecrawl: { apiKey: "proto-key", baseUrl: "https://proto.test" },
    });
    const cfg = {
      tools: {
        web: {
          search,
        },
      },
    } as OpenClawConfig;

    // The inherited firecrawl entry must be ignored; no plugin config or legacy
    // own entry means apiKey/baseUrl fall through to env/defaults.
    expect(resolveFirecrawlSearchConfig(cfg)).toBeUndefined();
    expect(resolveFirecrawlApiKey(cfg)).toBeUndefined();
    expect(resolveFirecrawlBaseUrl(cfg)).not.toBe("https://proto.test");
  });

  it("ignores inherited firecrawl property from tools.web.fetch prototype", () => {
    const fetch = Object.create({
      firecrawl: { onlyMainContent: false, maxAgeMs: 88888, timeoutSeconds: 44 },
    });
    const cfg = {
      tools: {
        web: {
          fetch,
        },
      },
    } as OpenClawConfig;

    expect(resolveFirecrawlOnlyMainContent(cfg)).toBe(true); // default
    expect(resolveFirecrawlMaxAgeMs(cfg)).not.toBe(88888);
    expect(resolveFirecrawlScrapeTimeoutSeconds(cfg)).not.toBe(44);
  });

  it("plugin config still takes precedence over own legacy firecrawl entries", () => {
    const cfg = {
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "plugin-key",
                baseUrl: "https://plugin.test",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            firecrawl: { apiKey: "legacy-key", baseUrl: "https://legacy.test" },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveFirecrawlSearchConfig(cfg)).toEqual({
      apiKey: "plugin-key",
      baseUrl: "https://plugin.test",
    });
    expect(resolveFirecrawlApiKey(cfg)).toBe("plugin-key");
  });

  it("falls through to env/defaults when no own firecrawl entry exists", () => {
    // tools.web.search exists but has no own or inherited firecrawl entry
    const cfg = {
      tools: {
        web: {
          search: { someOtherKey: "irrelevant" },
        },
      },
    } as OpenClawConfig;

    expect(resolveFirecrawlSearchConfig(cfg)).toBeUndefined();
  });

  it("ignores proto-inherited firecrawl through full credential resolution path", () => {
    // Proto-inherited firecrawl on search config should not leak into
    // the full apiKey/baseUrl resolution when no plugin config or env var.
    const search = Object.create({
      firecrawl: { apiKey: "proto-cred-key", baseUrl: "https://proto-cred.test" },
    });
    const cfg = {
      tools: { web: { search } },
    } as OpenClawConfig;

    expect(resolveFirecrawlSearchConfig(cfg)).toBeUndefined();
    expect(resolveFirecrawlApiKey(cfg)).toBeUndefined();
    expect(resolveFirecrawlBaseUrl(cfg)).not.toBe("https://proto-cred.test");
  });

  it("ignores proto-inherited fetch firecrawl through full credential resolution path", () => {
    const fetch = Object.create({
      firecrawl: { onlyMainContent: false, maxAgeMs: 88888, timeoutSeconds: 44 },
    });
    const cfg = {
      tools: { web: { fetch } },
    } as OpenClawConfig;

    expect(resolveFirecrawlOnlyMainContent(cfg)).toBe(true);
    expect(resolveFirecrawlMaxAgeMs(cfg)).not.toBe(88888);
    expect(resolveFirecrawlScrapeTimeoutSeconds(cfg)).not.toBe(44);
  });

  describe("canonical plugin config inheritance", () => {
    // The canonical Firecrawl credential path is:
    //   plugins.entries.firecrawl.config.webSearch (primary)
    //   tools.web.search.firecrawl (legacy fallback via Object.hasOwn)
    // This PR seals the legacy path with Object.hasOwn().

    it("rejects proto-inherited firecrawl on search even with plugin config present but empty", () => {
      // Plugin config is present but empty; the legacy path uses
      // Object.hasOwn(searchRecord, "firecrawl") to reject proto values.
      const search = Object.create({
        firecrawl: { apiKey: "proto-key", baseUrl: "https://proto.test" },
      });
      const cfg = {
        plugins: {
          entries: {
            firecrawl: { config: {} },
          },
        },
        tools: {
          web: { search },
        },
      } as OpenClawConfig;

      expect(resolveFirecrawlSearchConfig(cfg)).toBeUndefined();
      expect(resolveFirecrawlApiKey(cfg)).toBeUndefined();
    });

    it("reads own firecrawl from legacy search when plugin config has no webSearch", () => {
      const cfg = {
        plugins: {
          entries: {
            firecrawl: { config: { webFetch: { apiKey: "fetch-only" } } },
          },
        },
        tools: {
          web: {
            search: {
              firecrawl: { apiKey: "legacy-search-key", baseUrl: "https://legacy.test" },
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveFirecrawlSearchConfig(cfg)).toEqual({
        apiKey: "legacy-search-key",
        baseUrl: "https://legacy.test",
      });
    });

    it("plugin config takes precedence over own legacy firecrawl entry (backward compat)", () => {
      const cfg = {
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webSearch: {
                  apiKey: "plugin-override-key",
                  baseUrl: "https://plugin-override.test",
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              firecrawl: { apiKey: "legacy-key", baseUrl: "https://legacy.test" },
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveFirecrawlSearchConfig(cfg)).toEqual({
        apiKey: "plugin-override-key",
        baseUrl: "https://plugin-override.test",
      });
      expect(resolveFirecrawlApiKey(cfg)).toBe("plugin-override-key");
    });
  });
});
