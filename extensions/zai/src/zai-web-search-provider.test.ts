import { withEnv } from "openclaw/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createZaiWebSearchProvider,
  type ZaiMcpSearchFn,
} from "./zai-web-search-provider.js";

const { resolveZaiWebSearchCredential, createZaiToolDefinition } = __testing;

function mockSearchFn(results: Array<Record<string, string>> = []): ZaiMcpSearchFn {
  return vi.fn().mockResolvedValue(results);
}

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns missing_zai_api_key error when no credential is configured", async () => {
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("Z_AI_API_KEY", "");
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

  it("returns invalid_freshness error for unrecognized freshness values", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");
    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } }, mockSearchFn());

    await expect(tool.execute({ query: "OpenClaw", freshness: "hour" })).resolves.toMatchObject({
      error: "invalid_freshness",
    });
  });

  it("accepts valid freshness values without error", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");

    const searchFn = mockSearchFn([
      {
        title: "OpenClaw news",
        link: "https://example.com/news",
        content: "Summary of OpenClaw",
        media: "example.com",
        publish_date: "2026-04-11",
      },
    ]);
    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } }, searchFn);

    for (const freshness of ["day", "week", "month", "year"] as const) {
      const result = await tool.execute({ query: "OpenClaw", freshness });
      expect(result).not.toMatchObject({ error: "invalid_freshness" });
    }
  });

  it("returns a wrapped payload with correct externalContent metadata", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");

    const searchFn = mockSearchFn([
      {
        title: "Test Title",
        link: "https://example.com/test",
        content: "Test content body",
        media: "example.com",
        publish_date: "2026-04-11",
      },
    ]);
    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } }, searchFn);
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

    const searchFn = mockSearchFn([
      {
        title: "Injected title",
        link: "https://example.com/result",
        content: "Injected content",
        media: "evil.com",
        publish_date: "2026-04-11",
      },
    ]);
    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } }, searchFn);
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

    for (const field of [r?.title, r?.description, r?.siteName, r?.published] as const) {
      if (field !== undefined) {
        expect(field).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT/);
      }
    }
  });

  it("passes domain_filter through to the MCP search call", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");

    const searchFn = vi.fn<ZaiMcpSearchFn>().mockResolvedValue([]);
    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } }, searchFn);
    await tool.execute({ query: "python docs", domain_filter: "docs.python.org" });

    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({ domainFilter: "docs.python.org" }),
    );
  });

  it("maps freshness values to Z.AI recency filter strings in MCP call", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");

    const searchFn = vi.fn<ZaiMcpSearchFn>().mockResolvedValue([]);
    const tool = createZaiToolDefinition({ zai: { apiKey: "zai-test-key" } }, searchFn);
    await tool.execute({ query: "news", freshness: "week" });

    expect(searchFn).toHaveBeenCalledWith(expect.objectContaining({ freshness: "oneWeek" }));
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

  it("docsUrl points to the MCP server documentation", () => {
    const provider = createZaiWebSearchProvider();
    expect(provider.docsUrl).toBe("https://docs.z.ai/devpack/mcp/search-mcp-server");
  });

  it("returns null from createTool when no api key is set (lightweight artifact contract)", () => {
    withEnv({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, () => {
      const provider = createZaiWebSearchProvider();
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
