import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FIRECRAWL_BASE_URL,
  resolveFirecrawlApiKey,
  resolveFirecrawlBaseUrl,
} from "./config.js";
import { runFirecrawlScrape, runFirecrawlSearch } from "./firecrawl-client.js";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

describe("firecrawl legacy config own entries", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.unstubAllEnvs();
  });

  it.each(["search", "fetch"] as const)(
    "ignores inherited legacy %s firecrawl config entries",
    (configKey) => {
      vi.stubEnv("FIRECRAWL_API_KEY", "");
      vi.stubEnv("FIRECRAWL_BASE_URL", "");
      const inheritedConfig = Object.create({
        firecrawl: {
          apiKey: "inherited-key",
          baseUrl: "https://inherited.firecrawl.test",
        },
      });
      const cfg = {
        tools: { web: { [configKey]: inheritedConfig } },
      } as OpenClawConfig;

      expect(resolveFirecrawlApiKey(cfg)).toBeUndefined();
      expect(resolveFirecrawlBaseUrl(cfg)).toBe(DEFAULT_FIRECRAWL_BASE_URL);
    },
  );

  it("ignores inherited legacy search config through the Firecrawl client path", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "env-search-key");
    vi.stubEnv("FIRECRAWL_BASE_URL", "");
    const inheritedConfig = Object.create({
      firecrawl: {
        apiKey: "inherited-search-key",
        baseUrl: "http://127.0.0.1:8787",
      },
    });
    const cfg = {
      tools: { web: { search: inheritedConfig } },
    } as OpenClawConfig;
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = requestUrl(input);
      capturedAuth = new Headers(init?.headers).get("Authorization");
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ url: "https://example.com", title: "Example" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await runFirecrawlSearch({
      cfg,
      query: "openclaw inherited search config proof",
      count: 1,
    });

    expect(capturedUrl).toBe("https://api.firecrawl.dev/v2/search");
    expect(capturedAuth).toBe("Bearer env-search-key");
  });

  it("ignores inherited legacy fetch config through the Firecrawl client path", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "env-fetch-key");
    vi.stubEnv("FIRECRAWL_BASE_URL", "");
    const inheritedConfig = Object.create({
      firecrawl: {
        apiKey: "inherited-fetch-key",
        baseUrl: "http://127.0.0.1:8788",
      },
    });
    const cfg = {
      tools: { web: { fetch: inheritedConfig } },
    } as OpenClawConfig;
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = requestUrl(input);
      capturedAuth = new Headers(init?.headers).get("Authorization");
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: "Firecrawl fetch proof",
            metadata: { sourceURL: "https://example.com/firecrawl-proof" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await runFirecrawlScrape({
      cfg,
      url: "https://example.com/firecrawl-proof",
      extractMode: "markdown",
    });

    expect(capturedUrl).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(capturedAuth).toBe("Bearer env-fetch-key");
  });
});
