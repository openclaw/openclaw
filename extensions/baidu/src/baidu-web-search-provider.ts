import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const BAIDU_SEARCH_API_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/web_search";

type BaiduConfig = {
  apiKey?: string;
};

type BaiduSearchResult = {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  website?: string;
};

type BaiduSearchResponse = {
  references?: BaiduSearchResult[];
};

function createBaiduSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-20).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Baidu." })),
    language: Type.Optional(Type.String({ description: "Not supported by Baidu." })),
    freshness: Type.Optional(Type.String({ description: "Not supported by Baidu." })),
    date_after: Type.Optional(Type.String({ description: "Not supported by Baidu." })),
    date_before: Type.Optional(Type.String({ description: "Not supported by Baidu." })),
  });
}

function resolveBaiduConfig(searchConfig?: SearchConfigRecord): BaiduConfig {
  const baidu = searchConfig?.baidu;
  return baidu && typeof baidu === "object" && !Array.isArray(baidu) ? (baidu as BaiduConfig) : {};
}

function resolveBaiduApiKey(baidu?: BaiduConfig): string | undefined {
  return (
    readConfiguredSecretString(baidu?.apiKey, "tools.web.search.baidu.apiKey") ??
    readProviderEnvValue(["BAIDU_SEARCH_API_KEY"])
  );
}

async function runBaiduSearch(params: {
  query: string;
  apiKey: string;
  timeoutSeconds: number;
  count: number;
}): Promise<{ results: BaiduSearchResult[] }> {
  const body: Record<string, unknown> = {
    resource_type_filter: [
      { type: "web", top_k: params.count > 0 ? params.count : DEFAULT_SEARCH_COUNT },
    ],
    messages: [
      {
        role: "user",
        content: params.query,
      },
    ],
  };
  return withTrustedWebSearchEndpoint(
    {
      url: BAIDU_SEARCH_API_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "X-Appbuilder-From": "openclaw",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Baidu API error (${res.status}): ${detail || res.statusText}`);
      }
      const data = (await res.json()) as BaiduSearchResponse;
      const results = Array.isArray(data.references) ? data.references : [];
      const mapped = results.map((entry) => {
        const snippet = entry.snippet ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const site = entry.website ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url, // Keep raw for tool chaining
          snippet: snippet ? wrapWebContent(snippet, "web_search") : "",
          date: entry.date || undefined,
          site: site,
        };
      });
      return { results: mapped };
    },
  );
}

function createBaiduToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description: "Search the web using Baidu Search",
    parameters: createBaiduSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      for (const name of ["country", "language", "freshness", "date_after", "date_before"]) {
        if (readStringParam(params, name)) {
          const label =
            name === "country"
              ? "country filtering"
              : name === "language"
                ? "language filtering"
                : name === "freshness"
                  ? "freshness filtering"
                  : "date_after/date_before filtering";
          return {
            error: name.startsWith("date_") ? "unsupported_date_filter" : `unsupported_${name}`,
            message: `${label} is not supported by the baidu provider. Only Brave and Perplexity support ${name === "country" ? "country filtering" : name === "language" ? "language filtering" : name === "freshness" ? "freshness" : "date filtering"}.`,
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }
      }

      const baiduConfig = resolveBaiduConfig(searchConfig);
      const apiKey = resolveBaiduApiKey(baiduConfig);
      if (!apiKey) {
        return {
          error: "missing_baidu_search_api_key",
          message:
            "web_search (baidu) needs a Baidu Search API key. Set BAIDU_SEARCH_API_KEY in the Gateway environment, or configure plugins.entries.baidu.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const cacheKey = buildSearchCacheKey([
        "baidu",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const { results } = await runBaiduSearch({
        query,
        apiKey,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
      });
      const payload = {
        query: params.query,
        provider: params.provider,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: params.provider,
          wrapped: true,
        },
        results: results,
      };
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createBaiduWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "baidu",
    label: "Baidu Search",
    hint: "Structured results",
    envVars: ["BAIDU_SEARCH_API_KEY"],
    placeholder: "bce...",
    signupUrl: "https://console.bce.baidu.com/ai-search/qianfan/ais/console/apiKey",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 5,
    credentialPath: "plugins.entries.baidu.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.baidu.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => {
      const baidu = searchConfig?.baidu;
      return baidu && typeof baidu === "object" && !Array.isArray(baidu)
        ? (baidu as Record<string, unknown>).apiKey
        : undefined;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const scoped = searchConfigTarget.baidu;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        searchConfigTarget.baidu = { apiKey: value };
        return;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "baidu")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "baidu", "apiKey", value);
    },
    createTool: (ctx) =>
      createBaiduToolDefinition(
        (() => {
          const searchConfig = ctx.searchConfig as SearchConfigRecord | undefined;
          const pluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "baidu");
          if (!pluginConfig) {
            return searchConfig;
          }
          return {
            ...(searchConfig ?? {}),
            baidu: {
              ...resolveBaiduConfig(searchConfig),
              ...pluginConfig,
            },
          } as SearchConfigRecord;
        })(),
      ),
  };
}

export const __testing = {
  resolveBaiduConfig,
  resolveBaiduApiKey,
  runBaiduSearch,
} as const;
