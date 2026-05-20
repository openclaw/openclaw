import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  postTrustedWebToolsJson,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  APIFY_CREDENTIAL_PATH,
  APIFY_INTEGRATION_HEADERS,
  APIFY_PLUGIN_ID,
} from "./apify-shared.js";

const APIFY_ACTOR_ENDPOINT =
  "https://api.apify.com/v2/acts/apify~rag-web-browser/run-sync-get-dataset-items";

const DEFAULT_APIFY_COUNT = 5;

type ApifyResultItem = {
  searchResult?: { title?: string; description?: string; url?: string };
  metadata?: { title?: string; url?: string };
  markdown?: string;
};

function resolveApifyApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, APIFY_CREDENTIAL_PATH) ??
    readProviderEnvValue(["APIFY_API_KEY"])
  );
}

function missingApifyKeyPayload() {
  return {
    error: "missing_apify_api_key",
    message:
      "web_search (apify) needs an Apify API token. Set APIFY_API_KEY in the environment, or configure plugins.entries.apify.config.apiKey.",
    docs: "https://apify.com/apify/rag-web-browser",
  };
}

export async function executeApifySearch(
  args: Record<string, unknown>,
  searchConfig: SearchConfigRecord | undefined,
): Promise<Record<string, unknown>> {
  const query = readStringParam(args, "query", { required: true });
  const apiKey = resolveApifyApiKey(searchConfig);
  if (!apiKey) {
    return missingApifyKeyPayload();
  }

  const countArg = readNumberParam(args, "count", { integer: true });
  const count = resolveSearchCount(countArg, searchConfig?.maxResults ?? DEFAULT_APIFY_COUNT);
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

  const cacheKey = buildSearchCacheKey(["apify-rag-search", query, count, timeoutSeconds]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();

  const items = await postTrustedWebToolsJson<ApifyResultItem[]>(
    {
      url: APIFY_ACTOR_ENDPOINT,
      timeoutSeconds,
      apiKey,
      body: {
        query,
        maxResults: count,
        outputFormats: ["markdown"],
        requestTimeoutSecs: timeoutSeconds,
      },
      errorLabel: "Apify RAG Web Browser",
      extraHeaders: APIFY_INTEGRATION_HEADERS,
    },
    async (response) => {
      const data = (await response.json()) as ApifyResultItem[];
      return Array.isArray(data) ? data : [];
    },
  );

  const results = items.map((item) => {
    const url = item.searchResult?.url ?? item.metadata?.url ?? "";
    const title = item.searchResult?.title ?? item.metadata?.title ?? "";
    const description = item.searchResult?.description ?? item.markdown?.slice(0, 500) ?? "";
    return {
      title: title ? wrapWebContent(title, "web_search") : "",
      url,
      description: description ? wrapWebContent(description, "web_search") : "",
      siteName: resolveSiteName(url) || undefined,
    };
  });

  const payload = {
    query,
    provider: APIFY_PLUGIN_ID,
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: APIFY_PLUGIN_ID,
      wrapped: true,
    },
    results,
  };

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}

export const __testing = {
  resolveApifyApiKey,
};
