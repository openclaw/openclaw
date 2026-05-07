import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TINYFISH_BASE_URL,
  DEFAULT_TINYFISH_FETCH_TIMEOUT_SECONDS,
  DEFAULT_TINYFISH_SEARCH_TIMEOUT_SECONDS,
  resolveTinyFishApiKey,
  resolveTinyFishBaseUrl,
  resolveTinyFishFetchTimeoutSeconds,
  resolveTinyFishSearchTimeoutSeconds,
} from "./config.js";

const { runTinyFishSearch, runTinyFishFetch } = vi.hoisted(() => ({
  runTinyFishSearch: vi.fn(async (params: Record<string, unknown>) => params),
  runTinyFishFetch: vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    params,
  })),
}));

vi.mock("./tinyfish-client.js", () => ({
  runTinyFishSearch,
  runTinyFishFetch,
}));

describe("tinyfish tools", () => {
  const priorFetch = global.fetch;
  let createTinyFishWebSearchProvider: typeof import("./tinyfish-search-provider.js").createTinyFishWebSearchProvider;
  let createTinyFishWebFetchProvider: typeof import("./tinyfish-fetch-provider.js").createTinyFishWebFetchProvider;
  let tinyfishClientTesting: typeof import("./tinyfish-client.js").__testing;
  let ssrfMock: { mockRestore: () => void } | undefined;

  beforeAll(async () => {
    ({ createTinyFishWebFetchProvider } = await import("./tinyfish-fetch-provider.js"));
    ({ createTinyFishWebSearchProvider } = await import("./tinyfish-search-provider.js"));
    ({ __testing: tinyfishClientTesting } =
      await vi.importActual<typeof import("./tinyfish-client.js")>("./tinyfish-client.js"));
  });

  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
    runTinyFishSearch.mockReset();
    runTinyFishSearch.mockImplementation(async (params: Record<string, unknown>) => params);
    runTinyFishFetch.mockReset();
    runTinyFishFetch.mockImplementation(async (params: Record<string, unknown>) => ({
      ok: true,
      params,
    }));
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    global.fetch = priorFetch;
  });

  it("search provider exposes selection metadata and enables the plugin in config", () => {
    const provider = createTinyFishWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("tinyfish");
    expect(provider.credentialPath).toBe("plugins.entries.tinyfish.config.webSearch.apiKey");
    expect(applied.plugins?.entries?.tinyfish?.enabled).toBe(true);
  });

  it("fetch provider exposes selection metadata and enables the plugin in config", () => {
    const provider = createTinyFishWebFetchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("tinyfish");
    expect(provider.credentialPath).toBe("plugins.entries.tinyfish.config.webFetch.apiKey");
    expect(applied.plugins?.entries?.tinyfish?.enabled).toBe(true);
  });

  it("parses fetch payloads into wrapped external-content results", () => {
    const result = tinyfishClientTesting.parseTinyFishFetchPayload({
      payload: {
        results: [
          {
            url: "https://example.com",
            final_url: "https://example.com/final",
            title: "Example page",
            text: "# Hello\n\nWorld",
          },
        ],
        errors: [],
      },
      url: "https://example.com",
      extractMode: "text",
      maxChars: 1000,
    });

    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.extractor).toBe("tinyfish");
    expect(result.extractMode).toBe("text");
    expect((result.externalContent as Record<string, unknown>).untrusted).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.title).toBeTruthy();
  });

  it("parses fetch payloads in markdown mode", () => {
    const result = tinyfishClientTesting.parseTinyFishFetchPayload({
      payload: {
        results: [
          {
            url: "https://example.com",
            final_url: "https://example.com",
            title: "Test",
            text: "# Heading\n\nSome content here",
          },
        ],
        errors: [],
      },
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 5000,
    });

    expect(result.extractMode).toBe("markdown");
    expect(typeof result.text).toBe("string");
    expect((result.text as string).length).toBeGreaterThan(0);
  });

  it("throws when fetch payload has no results", () => {
    expect(() =>
      tinyfishClientTesting.parseTinyFishFetchPayload({
        payload: { results: [], errors: [] },
        url: "https://example.com",
        extractMode: "markdown",
        maxChars: 1000,
      }),
    ).toThrow("TinyFish fetch returned no content.");
  });

  it("throws when fetch payload has empty text", () => {
    expect(() =>
      tinyfishClientTesting.parseTinyFishFetchPayload({
        payload: {
          results: [{ url: "https://example.com", text: "" }],
          errors: [],
        },
        url: "https://example.com",
        extractMode: "markdown",
        maxChars: 1000,
      }),
    ).toThrow("TinyFish fetch returned no content.");
  });

  it("resolves search items from payload", () => {
    const items = tinyfishClientTesting.resolveSearchItems({
      results: [
        { position: 1, title: "Result 1", url: "https://a.com", snippet: "Snippet 1" },
        { position: 2, title: "Result 2", url: "https://b.com", snippet: "Snippet 2" },
        { title: "No URL" },
        null,
      ],
    });

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Result 1");
    expect(items[0].url).toBe("https://a.com");
    expect(items[0].snippet).toBe("Snippet 1");
    expect(items[0].siteName).toBe("a.com");
    expect(items[1].url).toBe("https://b.com");
  });

  it("returns empty array for non-array results", () => {
    expect(tinyfishClientTesting.resolveSearchItems({})).toEqual([]);
    expect(tinyfishClientTesting.resolveSearchItems({ results: "not-array" })).toEqual([]);
  });

  describe("SSRF target validation", () => {
    it("blocks private IPs in fetch URLs", () => {
      expect(() =>
        tinyfishClientTesting.assertTinyFishFetchTargetAllowed("https://127.0.0.1/secret"),
      ).toThrow("Blocked hostname");
    });

    it("blocks non-HTTP protocols in fetch URLs", () => {
      expect(() =>
        tinyfishClientTesting.assertTinyFishFetchTargetAllowed("file:///etc/passwd"),
      ).toThrow("Blocked non-HTTP(S) protocol");
    });

    it("blocks invalid URLs", () => {
      expect(() => tinyfishClientTesting.assertTinyFishFetchTargetAllowed("not-a-url")).toThrow(
        "Invalid URL",
      );
    });

    it("allows valid public URLs", () => {
      expect(() =>
        tinyfishClientTesting.assertTinyFishFetchTargetAllowed("https://example.com"),
      ).not.toThrow();
    });
  });

  describe("config resolution", () => {
    it("resolves API key from plugin config", () => {
      const cfg: OpenClawConfig = {
        plugins: {
          entries: {
            tinyfish: {
              enabled: true,
              config: {
                webSearch: { apiKey: "tf_live_test123" },
              },
            },
          },
        },
      };
      expect(resolveTinyFishApiKey(cfg)).toBe("tf_live_test123");
    });

    it("resolves API key from TINYFISH_API_KEY env var", () => {
      vi.stubEnv("TINYFISH_API_KEY", "tf_live_env_key");
      expect(resolveTinyFishApiKey({})).toBe("tf_live_env_key");
    });

    it("returns undefined when no API key is configured", () => {
      expect(resolveTinyFishApiKey({})).toBeUndefined();
    });

    it("resolves base URL from plugin config", () => {
      const cfg: OpenClawConfig = {
        plugins: {
          entries: {
            tinyfish: {
              enabled: true,
              config: {
                webSearch: { baseUrl: "https://custom.tinyfish.ai" },
              },
            },
          },
        },
      };
      expect(resolveTinyFishBaseUrl(cfg)).toBe("https://custom.tinyfish.ai");
    });

    it("falls back to default base URL", () => {
      expect(resolveTinyFishBaseUrl({})).toBe(DEFAULT_TINYFISH_BASE_URL);
    });

    it("resolves search timeout with override", () => {
      expect(resolveTinyFishSearchTimeoutSeconds(45)).toBe(45);
    });

    it("falls back to default search timeout", () => {
      expect(resolveTinyFishSearchTimeoutSeconds()).toBe(DEFAULT_TINYFISH_SEARCH_TIMEOUT_SECONDS);
    });

    it("resolves fetch timeout with override", () => {
      expect(resolveTinyFishFetchTimeoutSeconds(90)).toBe(90);
    });

    it("falls back to default fetch timeout", () => {
      expect(resolveTinyFishFetchTimeoutSeconds()).toBe(DEFAULT_TINYFISH_FETCH_TIMEOUT_SECONDS);
    });
  });
});
