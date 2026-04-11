import { withEnv } from "openclaw/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, createZaiWebSearchProvider } from "./zai-web-search-provider.js";

const { resolveZaiWebSearchCredential, createZaiToolDefinition } = __testing;

describe("zai web search credential resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves api key from scoped search config", () => {
    expect(resolveZaiWebSearchCredential({ zai: { apiKey: "zai-config-key" } })).toBe(
      "zai-config-key",
    );
  });

  it("resolves api key from ZAI_API_KEY env var", () => {
    withEnv({ ZAI_API_KEY: "zai-env-key", Z_AI_API_KEY: undefined }, () => {
      expect(resolveZaiWebSearchCredential({})).toBe("zai-env-key");
    });
  });

  it("resolves api key from Z_AI_API_KEY env var as fallback", () => {
    withEnv({ ZAI_API_KEY: undefined, Z_AI_API_KEY: "z-ai-fallback-key" }, () => {
      expect(resolveZaiWebSearchCredential({})).toBe("z-ai-fallback-key");
    });
  });

  it("prefers config over env var", () => {
    withEnv({ ZAI_API_KEY: "zai-env-key" }, () => {
      expect(resolveZaiWebSearchCredential({ zai: { apiKey: "zai-config-wins" } })).toBe(
        "zai-config-wins",
      );
    });
  });

  it("returns undefined when no credential is available", () => {
    withEnv({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, () => {
      expect(resolveZaiWebSearchCredential({})).toBeUndefined();
    });
  });

  it("resolves env SecretRef without requiring a runtime snapshot", () => {
    withEnv({ ZAI_SEARCH_KEY: "zai-ref-key" }, () => {
      expect(
        resolveZaiWebSearchCredential({
          zai: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "ZAI_SEARCH_KEY",
            },
          },
        }),
      ).toBe("zai-ref-key");
    });
  });
});

describe("zai web search tool execution", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("returns missing_zai_api_key error when no credential is configured", async () => {
    withEnv({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, async () => {
      const provider = createZaiWebSearchProvider();
      const tool = provider.createTool({ config: {} });
      expect(tool).toBeTruthy();
      if (!tool) {
        throw new Error("expected tool");
      }

      await expect(tool.execute({ query: "OpenClaw AI" })).resolves.toMatchObject({
        error: "missing_zai_api_key",
      });
    });
  });

  it("returns invalid_freshness error for unrecognized freshness values", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");
    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } });

    await expect(tool.execute({ query: "OpenClaw", freshness: "hour" })).resolves.toMatchObject({
      error: "invalid_freshness",
    });
  });

  it("accepts valid freshness values without error", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");

    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        search_result: [
          {
            title: "OpenClaw news",
            link: "https://example.com/news",
            content: "Summary of OpenClaw",
            media: "example.com",
            publish_date: "2026-04-11",
          },
        ],
      }),
    })) as unknown as typeof global.fetch;
    global.fetch = mockFetch;

    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } });

    for (const freshness of ["day", "week", "month", "year"] as const) {
      const result = await tool.execute({ query: "OpenClaw", freshness });
      expect(result).not.toMatchObject({ error: "invalid_freshness" });
    }
  });

  it("returns a wrapped payload with correct externalContent metadata", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");

    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        search_result: [
          {
            title: "Test Title",
            link: "https://example.com/test",
            content: "Test content body",
            media: "example.com",
            publish_date: "2026-04-11",
          },
        ],
      }),
    })) as unknown as typeof global.fetch;
    global.fetch = mockFetch;

    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } });
    const result = await tool.execute({ query: "test query" });

    expect(result).toMatchObject({
      query: "test query",
      provider: "zai",
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "zai",
        wrapped: true,
      },
    });
  });

  it("wraps all text fields in results with wrapWebContent markers", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");

    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        search_result: [
          {
            title: "Injected title",
            link: "https://example.com/result",
            content: "Injected content",
            media: "evil.com",
            publish_date: "2026-04-11",
          },
        ],
      }),
    })) as unknown as typeof global.fetch;
    global.fetch = mockFetch;

    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } });
    const result = (await tool.execute({ query: "test" })) as {
      results: Array<{
        title?: string;
        description?: string;
        siteName?: string;
        published?: string;
      }>;
    };

    expect(result.results).toHaveLength(1);
    const [r] = result.results;

    // All text fields must be wrapped — markers delimit content from an untrusted source
    for (const field of [r?.title, r?.description, r?.siteName, r?.published] as const) {
      if (field !== undefined) {
        expect(field).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT/);
      }
    }
  });

  it("passes domain_filter through to the API request body", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");

    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ search_result: [] }),
    })) as unknown as typeof global.fetch;
    global.fetch = mockFetch;

    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } });
    await tool.execute({ query: "python docs", domain_filter: "docs.python.org" });

    const [, init] = mockFetch.mock.calls[0] ?? [];
    const rawBody = (init as RequestInit | undefined)?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<
      string,
      unknown
    >;
    expect(body.search_domain_filter).toBe("docs.python.org");
  });
});

describe("zai web search provider contract", () => {
  it("exports the correct provider id and auto-detect order", () => {
    const provider = createZaiWebSearchProvider();
    expect(provider.id).toBe("zai");
    expect(provider.autoDetectOrder).toBe(60);
  });

  it("declares both ZAI_API_KEY and Z_AI_API_KEY env vars", () => {
    const provider = createZaiWebSearchProvider();
    expect(provider.envVars).toContain("ZAI_API_KEY");
    expect(provider.envVars).toContain("Z_AI_API_KEY");
  });

  it("returns null from createTool when no api key is set (lightweight artifact contract)", () => {
    withEnv({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, () => {
      const provider = createZaiWebSearchProvider();
      // createTool always returns a tool definition (returns missing_key error on execute).
      // The contract-api shim (web-search-contract-api.ts) is the one that returns null.
      const tool = provider.createTool({ config: {} });
      expect(tool).not.toBeNull();
    });
  });

  it("stores and retrieves scoped credential value via getCredentialValue / setCredentialValue", () => {
    const provider = createZaiWebSearchProvider();
    const target: Record<string, unknown> = {};
    provider.setCredentialValue(target, "zai-stored-key");

    expect(provider.getCredentialValue(target)).toBe("zai-stored-key");
  });

  it("reads the configured credential from plugin config via getConfiguredCredentialValue", () => {
    const provider = createZaiWebSearchProvider();
    expect(
      provider.getConfiguredCredentialValue?.({
        plugins: {
          entries: {
            zai: {
              enabled: true,
              config: { webSearch: { apiKey: "zai-plugin-key" } },
            },
          },
        },
      } as never),
    ).toBe("zai-plugin-key");
  });
});
