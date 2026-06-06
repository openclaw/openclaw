import { createRequire } from "node:module";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
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
  resolveSiteName,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const SELTZ_BASE_URL = "https://api.seltz.ai";
const SELTZ_SEARCH_PATHNAME = "/v1/search";

const require = createRequire(import.meta.url);
const PLUGIN_VERSION = readPluginPackageVersion({ require });
const USER_AGENT = `openclaw-seltz/${PLUGIN_VERSION} (${process.platform})`;

type SeltzConfig = {
  apiKey?: string;
  baseUrl?: string;
};

type SeltzSearchResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  publishedDate?: unknown;
  published_date?: unknown;
};

type SeltzSearchResponse = {
  documents?: unknown;
};

function resolveSeltzConfig(searchConfig?: SearchConfigRecord): SeltzConfig {
  const seltz = searchConfig?.seltz;
  return seltz && typeof seltz === "object" && !Array.isArray(seltz) ? (seltz as SeltzConfig) : {};
}

function resolveSeltzApiKey(seltz?: SeltzConfig): string | undefined {
  return (
    readConfiguredSecretString(seltz?.apiKey, "tools.web.search.seltz.apiKey") ??
    readProviderEnvValue(["SELTZ_API_KEY"])
  );
}

function invalidBaseUrlPayload(value: string) {
  return {
    error: "invalid_base_url",
    message: `plugins.entries.seltz.config.webSearch.baseUrl must be a valid http(s) URL. Got: ${value}`,
    docs: "https://docs.openclaw.ai/tools/seltz-search",
  };
}

function resolveSeltzSearchEndpoint(
  seltz?: SeltzConfig,
): { endpoint: string } | { error: string; message: string; docs: string } {
  const configured = normalizeOptionalString(seltz?.baseUrl);
  if (!configured) {
    return { endpoint: `${SELTZ_BASE_URL}${SELTZ_SEARCH_PATHNAME}` };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(configured) && !/^https?:\/\//i.test(configured)) {
    return invalidBaseUrlPayload(configured);
  }
  const candidate = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalidBaseUrlPayload(configured);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalidBaseUrlPayload(configured);
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith(SELTZ_SEARCH_PATHNAME)
    ? pathname
    : `${pathname === "" ? "" : pathname}${SELTZ_SEARCH_PATHNAME}`;
  parsed.hash = "";
  return { endpoint: parsed.toString() };
}

function normalizeSeltzQuery(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed || undefined;
}

function invalidQueryPayload() {
  return {
    error: "invalid_query",
    message: "query must be a non-empty search string.",
    docs: "https://docs.openclaw.ai/tools/seltz-search",
  };
}

function normalizeSeltzResults(payload: unknown): SeltzSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const documents = (payload as SeltzSearchResponse).documents;
  if (!Array.isArray(documents)) {
    return [];
  }
  return documents.filter((entry): entry is SeltzSearchResult =>
    Boolean(
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as SeltzSearchResult).url === "string" &&
      (entry as SeltzSearchResult).url,
    ),
  );
}

function buildSeltzCacheKey(params: { endpoint: string; query: string; count: number }): string {
  return buildSearchCacheKey(["seltz", params.endpoint, params.query, params.count]);
}

function missingSeltzKeyPayload() {
  return {
    error: "missing_seltz_api_key",
    message:
      "web_search (seltz) needs a Seltz API key. Set SELTZ_API_KEY in the Gateway environment, or configure plugins.entries.seltz.config.webSearch.apiKey.",
    docs: "https://docs.openclaw.ai/tools/seltz-search",
  };
}

async function runSeltzSearch(params: {
  apiKey: string;
  endpoint: string;
  query: string;
  maxResults: number;
  timeoutSeconds: number;
}): Promise<SeltzSearchResponse> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.maxResults,
  };

  return withTrustedWebSearchEndpoint(
    {
      url: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": params.apiKey,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Seltz API error (${res.status}): ${detail || res.statusText}`);
      }
      try {
        return (await res.json()) as SeltzSearchResponse;
      } catch (cause) {
        throw new Error("Seltz API returned malformed JSON", { cause });
      }
    },
  );
}

export async function executeSeltzWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "seltz",
    resolveProviderWebSearchPluginConfig(ctx.config, "seltz"),
  ) as SearchConfigRecord | undefined;
  const seltzConfig = resolveSeltzConfig(searchConfig);
  const apiKey = resolveSeltzApiKey(seltzConfig);
  if (!apiKey) {
    return missingSeltzKeyPayload();
  }
  const endpointResult = resolveSeltzSearchEndpoint(seltzConfig);
  if ("error" in endpointResult) {
    return endpointResult;
  }
  const endpoint = endpointResult.endpoint;

  const query = normalizeSeltzQuery(readStringParam(args, "query"));
  if (!query) {
    return invalidQueryPayload();
  }
  const requestedCount =
    readNumberParam(args, "count", { integer: true }) ??
    (typeof searchConfig?.maxResults === "number" ? searchConfig.maxResults : undefined);
  const count = resolveSearchCount(requestedCount, DEFAULT_SEARCH_COUNT);
  const cacheKey = buildSeltzCacheKey({
    endpoint,
    query,
    count,
  });
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const response = await runSeltzSearch({
    apiKey,
    endpoint,
    query,
    maxResults: count,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
  });
  const results = normalizeSeltzResults(response).map((entry) => {
    const url = typeof entry.url === "string" ? entry.url : "";
    const siteName = resolveSiteName(url) || undefined;
    const title = typeof entry.title === "string" ? entry.title : (siteName ?? url);
    const published =
      typeof entry.publishedDate === "string" && entry.publishedDate
        ? entry.publishedDate
        : typeof entry.published_date === "string" && entry.published_date
          ? entry.published_date
          : undefined;
    const description = typeof entry.content === "string" ? entry.content : "";
    return Object.assign(
      {
        title: title ? wrapWebContent(title, "web_search") : "",
        url,
        description: description ? wrapWebContent(description, "web_search") : "",
        siteName,
      },
      published ? { published } : {},
    );
  });

  const payload: Record<string, unknown> = {
    query,
    provider: "seltz",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "seltz",
      wrapped: true,
    },
    results,
  };
  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}

export const testing = {
  buildSeltzCacheKey,
  invalidQueryPayload,
  missingSeltzKeyPayload,
  normalizeSeltzQuery,
  normalizeSeltzResults,
  resolveSeltzApiKey,
  resolveSeltzConfig,
  resolveSeltzSearchEndpoint,
  USER_AGENT,
} as const;

export { testing as __testing };
