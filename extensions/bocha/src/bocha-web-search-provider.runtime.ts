import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  normalizeFreshness,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
  readResponseText,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  type BochaConfig,
  DEFAULT_BOCHA_BASE_URL,
  resolveBochaConfig,
} from "./bocha-web-search-provider.shared.js";

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

function resolveBochaApiKey(
  searchConfig?: SearchConfigRecord,
  bocha?: BochaConfig,
): string | undefined {
  return (
    // 1. Shared top-level slot (preferred for consistency)
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    // 2. Plugin-specific slot
    readConfiguredSecretString(bocha?.apiKey, "plugins.entries.bocha.config.webSearch.apiKey") ??
    // 3. Legacy environment variable
    readProviderEnvValue(["BOCHA_API_KEY"])
  );
}

function resolveBochaBaseUrl(bocha?: BochaConfig): string {
  const configured =
    readConfiguredSecretString(bocha?.baseUrl, "plugins.entries.bocha.config.webSearch.baseUrl") ??
    "";
  return configured || DEFAULT_BOCHA_BASE_URL;
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
          return `Title: ${page.name ?? ""}\nURL: ${page.url ?? ""}\nContent: ${text}`;
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

export async function executeBochaSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
): Promise<Record<string, unknown>> {
  const params = args;
  const bochaConfig = resolveBochaConfig(searchConfig);
  const apiKey = resolveBochaApiKey(searchConfig, bochaConfig);
  if (!apiKey) {
    return {
      error: "missing_bocha_api_key",
      message:
        "web_search (bocha) needs a Bocha API key. Set BOCHA_API_KEY in the Gateway environment, or configure plugins.entries.bocha.config.webSearch.apiKey.",
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
}

export const __testing = {
  resolveBochaConfig,
  resolveBochaApiKey,
  resolveBochaBaseUrl,
} as const;
