import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  enablePluginInConfig,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  throwWebSearchApiError,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_SEARXNG_BASE_URL = "http://localhost:8888";

type SearxngSearchResult = {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
  engine?: string;
};

type SearxngSearchResponse = {
  query?: string;
  results?: SearxngSearchResult[];
};

type SearxngPluginConfig =
  | {
      baseUrl?: string;
    }
  | undefined;

function resolveSearxngPluginConfig(cfg?: OpenClawConfig): SearxngPluginConfig {
  const pluginConfig = resolveProviderWebSearchPluginConfig(cfg, "searxng");
  if (pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)) {
    return pluginConfig as SearxngPluginConfig;
  }
  return undefined;
}

function validateSearxngBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SearXNG: invalid baseUrl "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `SearXNG: baseUrl must use http or https, got "${parsed.protocol.slice(0, -1)}"`,
    );
  }
}

function resolveSearxngBaseUrl(cfg?: OpenClawConfig): string {
  const pluginCfg = resolveSearxngPluginConfig(cfg);
  const fromConfig = typeof pluginCfg?.baseUrl === "string" ? pluginCfg.baseUrl.trim() : "";
  const fromEnv = (process.env.SEARXNG_BASE_URL ?? "").trim();
  const resolved = fromConfig || fromEnv || DEFAULT_SEARXNG_BASE_URL;
  validateSearxngBaseUrl(resolved);
  return resolved;
}

async function runSearxngSearch(params: {
  query: string;
  baseUrl: string;
  timeoutSeconds: number;
  language?: string;
}): Promise<SearxngSearchResult[]> {
  const base = params.baseUrl.trim().replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(`${base}/search`);
  } catch {
    throw new Error(`SearXNG: invalid baseUrl "${params.baseUrl}"`);
  }
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  if (params.language) {
    url.searchParams.set("language", params.language);
  }

  return withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    },
    async (res) => {
      if (!res.ok) {
        await throwWebSearchApiError(res, "SearXNG");
      }
      let data: SearxngSearchResponse;
      try {
        data = (await res.json()) as SearxngSearchResponse;
      } catch {
        throw new Error("SearXNG: failed to parse search response as JSON");
      }
      return data.results ?? [];
    },
  );
}

const SearxngWebSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: `Number of results (1-${MAX_SEARCH_COUNT}).`,
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    search_lang: Type.Optional(
      Type.String({
        description: "Language code for search results (e.g. en, de, fr).",
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Time filter (not supported by SearXNG; will return an error if set).",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createSearxngWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "searxng",
    label: "SearXNG",
    hint: "Self-hosted metasearch · no API key required",
    envVars: ["SEARXNG_BASE_URL"],
    placeholder: "http://localhost:8888",
    signupUrl: "https://docs.searxng.org/",
    docsUrl: "https://docs.openclaw.ai/tools/searxng",
    autoDetectOrder: 999,
    requiresCredential: false,
    onboardingScopes: ["text-inference"],
    credentialPath: "plugins.entries.searxng.config.webSearch.baseUrl",
    inactiveSecretPaths: [],
    // SearXNG is key-free; all credential accessors are no-ops.
    getCredentialValue: () => undefined,
    setCredentialValue: () => undefined,
    getConfiguredCredentialValue: () => undefined,
    setConfiguredCredentialValue: () => undefined,
    applySelectionConfig: (config) => enablePluginInConfig(config, "searxng").config,
    createTool: (ctx) => {
      const baseUrl = resolveSearxngBaseUrl(ctx.config);
      const timeoutSeconds = resolveSearchTimeoutSeconds(ctx.searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(ctx.searchConfig);

      return {
        description:
          "Search the web using SearXNG (self-hosted meta search engine). Aggregates results from multiple search engines. Returns titles, URLs, and snippets.",
        parameters: SearxngWebSearchSchema,
        execute: async (args) => {
          const params = args as Record<string, unknown>;
          const query = typeof params.query === "string" ? params.query.trim() : "";
          if (!query) {
            return { error: "missing_query", message: "query is required." };
          }

          const count = resolveSearchCount(
            typeof params.count === "number" ? params.count : undefined,
            DEFAULT_SEARCH_COUNT,
          );
          const language = typeof params.search_lang === "string" ? params.search_lang : undefined;

          // SearXNG does not support freshness filtering.
          const unsupported = buildUnsupportedSearchFilterResponse(params, "searxng");
          if (unsupported) {
            return unsupported;
          }

          const cacheKey = buildSearchCacheKey(["searxng", query, count, language ?? "default"]);
          const cached = readCachedSearchPayload(cacheKey);
          if (cached) {
            return cached;
          }

          const start = Date.now();
          const results = await runSearxngSearch({
            query,
            baseUrl,
            timeoutSeconds,
            language,
          });

          const mapped = results.slice(0, count).map((entry) => {
            const title = entry.title ?? "";
            const url = entry.url ?? "";
            const description = entry.content ?? "";
            const rawSiteName = resolveSiteName(url);
            return {
              title: title ? wrapWebContent(title, "web_search") : "",
              url,
              description: description ? wrapWebContent(description, "web_search") : "",
              published: entry.publishedDate || undefined,
              siteName: rawSiteName || undefined,
              engine: entry.engine || undefined,
            };
          });

          const payload = {
            query,
            provider: "searxng",
            tookMs: Date.now() - start,
            count: mapped.length,
            externalContent: {
              untrusted: true,
              source: "web_search",
              provider: "searxng",
              wrapped: true,
            },
            results: mapped,
          };
          writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
          return payload;
        },
      };
    },
  };
}

export const __testing = {
  resolveSearxngBaseUrl,
  resolveSearxngPluginConfig,
} as const;
