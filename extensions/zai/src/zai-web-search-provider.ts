import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  getScopedCredentialValue,
  mergeScopedSearchConfig,
  normalizeFreshness,
  readCachedSearchPayload,
  readNumberParam,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveWebSearchProviderCredential,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";

const ZAI_SEARCH_ENDPOINT = "https://api.z.ai/api/paas/v4/web_search";

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

type ZaiSearchResponse = {
  id?: string;
  created?: number;
  search_result?: ZaiSearchResult[];
};

function resolveZaiWebSearchCredential(searchConfig?: Record<string, unknown>): string | undefined {
  return resolveWebSearchProviderCredential({
    credentialValue: getScopedCredentialValue(searchConfig, "zai"),
    path: "tools.web.search.zai.apiKey",
    envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
  });
}

async function runZaiSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  freshness?: string;
  domainFilter?: string;
}): Promise<ZaiSearchResponse> {
  const body: Record<string, unknown> = {
    search_engine: "search-prime",
    search_query: params.query,
    count: Math.max(1, Math.min(50, params.count)),
  };

  if (params.freshness && ZAI_FRESHNESS_MAP[params.freshness]) {
    body.search_recency_filter = ZAI_FRESHNESS_MAP[params.freshness];
  }
  if (params.domainFilter) {
    body.search_domain_filter = params.domainFilter;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: ZAI_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
          "Accept-Language": "en-US,en",
        },
        body: JSON.stringify(body),
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Z.AI Search API error (${response.status}): ${detail || response.statusText}`,
        );
      }
      return (await response.json()) as ZaiSearchResponse;
    },
  );
}

function createZaiToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Z.AI Web Search API. Returns structured results (titles, URLs, summaries) with intent-enhanced retrieval optimised for LLMs. Supports time-range and domain filters.",
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
          docs: "https://docs.z.ai/guides/tools/web-search",
        };
      }

      const query = readStringParam(args, "query", { required: true });
      const rawCount = readNumberParam(args, "count", { integer: true });
      const count = resolveSearchCount(rawCount ?? searchConfig?.maxResults, DEFAULT_SEARCH_COUNT);

      const rawFreshness = readStringParam(args, "freshness");
      // Reuse perplexity normalisation: accepts brave shortcuts (pd/pw/pm/py) and
      // recency words (day/week/month/year) and always returns recency words.
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "perplexity") : undefined;
      if (rawFreshness && !freshness) {
        return {
          error: "invalid_freshness",
          message: "freshness must be 'day', 'week', 'month', or 'year'.",
          docs: "https://docs.z.ai/guides/tools/web-search",
        };
      }

      const domainFilter = readStringParam(args, "domain_filter");

      const cacheKey = buildSearchCacheKey(["zai", query, count, freshness, domainFilter]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const startedAt = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const data = await runZaiSearch({
        query,
        count,
        apiKey,
        timeoutSeconds,
        freshness,
        domainFilter: domainFilter ?? undefined,
      });

      const results = (data.search_result ?? []).slice(0, count).map((r) => ({
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
    hint: "Intent-enhanced retrieval · time/domain filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Z.AI API key",
    envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    placeholder: "zai-...",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
    docsUrl: "https://docs.z.ai/guides/tools/web-search",
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
