import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  getScopedCredentialValue,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  normalizeFreshness,
  readResponseText,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_BOCHA_BASE_URL = "https://api.bocha.cn/v1";

type BochaConfig = {
  apiKey?: string;
  baseUrl?: string;
  summary?: boolean;
};

type BochaSearchResponse = {
  code: number;
  msg: string;
  data?: {
    webPages?: {
      value?: Array<{
        name?: string;
        url?: string;
        snippet?: string;
        summary?: string; // original content
        datePublished?: string;
        dateLastCrawled?: string;
        siteName?: string;
        siteIcon?: string;
      }>;
    };
  };
};

function resolveBochaConfig(searchConfig?: SearchConfigRecord): BochaConfig {
  const bocha = searchConfig?.bocha;
  return bocha && typeof bocha === "object" && !Array.isArray(bocha) ? (bocha as BochaConfig) : {};
}

function resolveBochaApiKey(bocha?: BochaConfig): string | undefined {
  return (
    readConfiguredSecretString(bocha?.apiKey, "tools.web.search.bocha.apiKey") ??
    readProviderEnvValue(["BOCHA_API_KEY"])
  );
}

function resolveBochaBaseUrl(bocha?: BochaConfig): string {
  const baseUrl = typeof bocha?.baseUrl === "string" ? bocha.baseUrl.trim() : "";
  return baseUrl || DEFAULT_BOCHA_BASE_URL;
}

async function runBochaSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  count: number;
  freshness?: string;
  summary?: boolean;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const endpoint = `${params.baseUrl.trim().replace(/\/$/, "")}/web-search`;
  const body = {
    query: params.query,
    count: params.count,
    ...(params.freshness ? { freshness: params.freshness } : {}),
    ...(typeof params.summary === "boolean" ? { summary: params.summary } : {}),
  };

  return await withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    },
    async (res): Promise<{ content: string; citations: string[] }> => {
      if (!res.ok) {
        const detail = await readResponseText(res, { maxBytes: 64_000 });
        throw new Error(`Bocha API error (${res.status}): ${detail.text || res.statusText}`);
      }

      const data = (await res.json()) as BochaSearchResponse;
      if (data.code !== 200) {
        throw new Error(`Bocha API error (${data.code}): ${data.msg}`);
      }

      const pages = data.data?.webPages?.value ?? [];
      const content = pages
        .map((page) => {
          const text = page.summary || page.snippet || "";
          return `Title: ${page.name}\nURL: ${page.url}\nContent: ${text}`;
        })
        .join("\n\n");
      const citations = pages.map((page) => page.url).filter((url): url is string => Boolean(url));

      return {
        content: content || "No results found.",
        citations,
      };
    },
  );
}

function createBochaSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: `Number of results to return (1-${MAX_SEARCH_COUNT}). Default is ${DEFAULT_SEARCH_COUNT}.`,
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Time range (oneDay, oneWeek, oneMonth, oneYear, noLimit).",
      }),
    ),
    summary: Type.Optional(
      Type.Boolean({
        description: "Whether to return the original web content (summary).",
      }),
    ),
  });
}

function createBochaToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description: "Search the web using Bocha Web Search API.",
    parameters: createBochaSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      const bochaConfig = resolveBochaConfig(searchConfig);
      const apiKey = resolveBochaApiKey(bochaConfig);
      if (!apiKey) {
        return {
          error: "missing_bocha_api_key",
          message:
            "web_search (bocha) needs a Bocha API key. Set BOCHA_API_KEY in the Gateway environment, or configure tools.web.search.bocha.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count = Math.max(
        Math.min(
          readNumberParam(params, "count", { integer: true }) ??
            searchConfig?.maxResults ??
            DEFAULT_SEARCH_COUNT,
          MAX_SEARCH_COUNT,
        ),
        1,
      );
      const rawFreshness = readStringParam(params, "freshness");
      const freshness = normalizeFreshness(rawFreshness, "bocha") || "noLimit";
      const paramSummary = typeof params.summary === "boolean" ? params.summary : undefined;
      const summary = paramSummary ?? bochaConfig.summary ?? true;
      const baseUrl = resolveBochaBaseUrl(bochaConfig);
      const cacheKey = buildSearchCacheKey([
        "bocha",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        freshness,
        Boolean(summary),
        baseUrl,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runBochaSearch({
        query,
        apiKey,
        baseUrl,
        count,
        freshness,
        summary,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });

      const payload = {
        query,
        provider: "bocha",
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "bocha",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
      };

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createBochaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "bocha",
    label: "Bocha Web Search",
    hint: "Requires Bocha Web Search API key · High quality web search",
    credentialLabel: "Bocha Web Search API key",
    envVars: ["BOCHA_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://open.bocha.cn/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 15,
    credentialPath: "plugins.entries.bocha.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.bocha.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "bocha"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "bocha", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "bocha")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "bocha", "apiKey", value);
    },
    createTool: (ctx) =>
      createBochaToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "bocha",
          resolveProviderWebSearchPluginConfig(ctx.config, "bocha"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveBochaConfig,
  resolveBochaApiKey,
  resolveBochaBaseUrl,
  normalizeFreshness,
} as const;
