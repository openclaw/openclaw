import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  getScopedCredentialValue,
  MAX_SEARCH_COUNT,
  mergeScopedSearchConfig,
  normalizeFreshness,
  readCachedSearchPayload,
  readNumberParam,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveWebSearchProviderCredential,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  wrapWebContent,
  writeCachedSearchPayload,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";

const ZAI_MCP_ENDPOINT = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const ZAI_MCP_TOOL = "web_search_prime";

const ZAI_FRESHNESS_MAP: Record<string, string> = {
  day: "oneDay",
  week: "oneWeek",
  month: "oneMonth",
  year: "oneYear",
};

type ZaiSearchResult = {
  title?: string;
  content?: string;
  link?: string;
  media?: string;
  icon?: string;
  refer?: string;
  publish_date?: string;
};

export type ZaiMcpSearchParams = {
  apiKey: string;
  query: string;
  freshness?: string;
  domainFilter?: string;
};

export type ZaiMcpSearchFn = (params: ZaiMcpSearchParams) => Promise<ZaiSearchResult[]>;

function resolveZaiWebSearchCredential(searchConfig?: Record<string, unknown>): string | undefined {
  return resolveWebSearchProviderCredential({
    credentialValue: getScopedCredentialValue(searchConfig, "zai"),
    path: "tools.web.search.zai.apiKey",
    envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
  });
}

async function callZaiMcpSearch(params: ZaiMcpSearchParams): Promise<ZaiSearchResult[]> {
  const client = new Client({ name: "openclaw", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(ZAI_MCP_ENDPOINT), {
    requestInit: {
      headers: { Authorization: `Bearer ${params.apiKey}` },
    },
  });

  try {
    await client.connect(transport);

    // Only pass schema-supported params: search_query, search_domain_filter,
    // search_recency_filter, content_size, location. `count` is not in the schema
    // and causes silent empty results — we slice on our side instead.
    const args: Record<string, unknown> = { search_query: params.query };
    if (params.freshness) {
      args.search_recency_filter = params.freshness;
    }
    if (params.domainFilter) {
      args.search_domain_filter = params.domainFilter;
    }

    const result = await client.callTool({ name: ZAI_MCP_TOOL, arguments: args });

    const textContent =
      (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text")
        ?.text ?? "[]";

    if (result.isError) {
      // Surface the raw server error (e.g. 429 quota exceeded)
      throw new Error(`Z.AI MCP search error: ${textContent}`);
    }

    // web_search_prime double-encodes its response: the text field contains a
    // JSON string whose value is itself a JSON array, e.g. text = '"[{...}]"'.
    // Parse once to unwrap the outer string, then parse again to get the array.
    const outer: unknown = JSON.parse(textContent);
    const parsed: unknown = typeof outer === "string" ? JSON.parse(outer) : outer;

    if (!Array.isArray(parsed)) {
      throw new Error(
        `Z.AI web search returned an unexpected response format: ${JSON.stringify(parsed)}`,
      );
    }

    return parsed as ZaiSearchResult[];
  } finally {
    await client.close().catch(() => {});
  }
}

function createZaiToolDefinition(
  searchConfig?: SearchConfigRecord,
  mcpSearchFn: ZaiMcpSearchFn = callZaiMcpSearch,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using the Z.AI Web Search Prime MCP. Returns structured results (titles, URLs, summaries) with intent-enhanced retrieval optimised for LLMs. Supports time-range and domain filters. Requires a GLM Coding Plan API key.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string." }),
      count: Type.Optional(
        Type.Number({
          description: `Number of results to return (1-${MAX_SEARCH_COUNT}).`,
          minimum: 1,
          maximum: MAX_SEARCH_COUNT,
        }),
      ),
      freshness: Type.Optional(
        Type.String({
          description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
        }),
      ),
      domain_filter: Type.Optional(
        Type.String({
          description:
            "Restrict results to a single domain (e.g. 'docs.python.org'). Allowlist only — one domain per call.",
        }),
      ),
    }),
    execute: async (args: Record<string, unknown>) => {
      const apiKey = resolveZaiWebSearchCredential(searchConfig);
      if (!apiKey) {
        return {
          error: "missing_zai_api_key",
          message:
            "web_search (zai) needs a Z.AI API key. Set ZAI_API_KEY in the Gateway environment, or configure plugins.entries.zai.config.webSearch.apiKey.",
          docs: "https://docs.z.ai/devpack/mcp/search-mcp-server",
        };
      }

      const query = readStringParam(args, "query", { required: true });
      const rawCount = readNumberParam(args, "count", { integer: true });
      const count = resolveSearchCount(rawCount ?? searchConfig?.maxResults, DEFAULT_SEARCH_COUNT);

      const rawFreshness = readStringParam(args, "freshness");
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "perplexity") : undefined;
      if (rawFreshness && !freshness) {
        return {
          error: "invalid_freshness",
          message: "freshness must be 'day', 'week', 'month', or 'year'.",
          docs: "https://docs.z.ai/devpack/mcp/search-mcp-server",
        };
      }

      const domainFilter = readStringParam(args, "domain_filter");

      const cacheKey = buildSearchCacheKey(["zai", query, count, freshness, domainFilter]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const startedAt = Date.now();

      const rawResults = await mcpSearchFn({
        apiKey,
        query,
        freshness: freshness ? ZAI_FRESHNESS_MAP[freshness] : undefined,
        domainFilter: domainFilter ?? undefined,
      });

      const results = rawResults.slice(0, count).map((r) => ({
        title: wrapWebContent(r.title ?? "", "web_search"),
        url: r.link ?? "",
        description: r.content ? wrapWebContent(r.content, "web_search") : undefined,
        siteName: r.media ? wrapWebContent(r.media, "web_search") : undefined,
        published: r.publish_date ? wrapWebContent(r.publish_date, "web_search") : undefined,
      }));

      const payload = {
        query,
        provider: "zai",
        count: results.length,
        tookMs: Date.now() - startedAt,
        results,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "zai",
          wrapped: true,
        },
      };

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createZaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "zai",
    label: "Z.AI Search",
    hint: "GLM Coding Plan Web Search Prime MCP · time/domain filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Z.AI API key",
    envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    placeholder: "zai-...",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
    docsUrl: "https://docs.z.ai/devpack/mcp/search-mcp-server",
    autoDetectOrder: 60,
    credentialPath: "plugins.entries.zai.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.zai.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig?: Record<string, unknown>) =>
      getScopedCredentialValue(searchConfig, "zai"),
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) =>
      setScopedCredentialValue(searchConfigTarget, "zai", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "zai")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "zai", "apiKey", value);
    },
    createTool: (ctx) =>
      createZaiToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "zai",
          resolveProviderWebSearchPluginConfig(ctx.config, "zai"),
          { mirrorApiKeyToTopLevel: true },
        ),
      ),
  };
}

export const __testing = {
  resolveZaiWebSearchCredential,
  createZaiToolDefinition,
} as const;
