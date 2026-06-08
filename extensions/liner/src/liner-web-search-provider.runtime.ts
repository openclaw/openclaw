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
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const LINER_BASE_URL = "https://platform.liner.com";
const LINER_SEARCH_PATHNAME = "/api/v1/search/web";
// Liner Search accepts max_results 1-50.
const LINER_MAX_SEARCH_COUNT = 50;

const require = createRequire(import.meta.url);
const PLUGIN_VERSION = readPluginPackageVersion({ require });
const USER_AGENT = `openclaw-liner/${PLUGIN_VERSION} (${process.platform})`;

type LinerConfig = {
  apiKey?: string;
  baseUrl?: string;
};

type LinerSearchResult = {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  date?: unknown;
};

export type LinerSearchResponse = {
  requestId?: unknown;
  results?: unknown;
  totalCount?: unknown;
};

function resolveLinerConfig(searchConfig?: SearchConfigRecord): LinerConfig {
  const liner = searchConfig?.liner;
  return liner && typeof liner === "object" && !Array.isArray(liner) ? (liner as LinerConfig) : {};
}

function resolveLinerApiKey(liner?: LinerConfig): string | undefined {
  return (
    readConfiguredSecretString(liner?.apiKey, "tools.web.search.liner.apiKey") ??
    readProviderEnvValue(["LINER_API_KEY"])
  );
}

function invalidBaseUrlPayload(value: string) {
  return {
    error: "invalid_base_url",
    message: `plugins.entries.liner.config.webSearch.baseUrl must be a valid http(s) URL. Got: ${value}`,
    docs: "https://docs.openclaw.ai/tools/liner-search",
  };
}

function resolveLinerSearchEndpoint(
  liner?: LinerConfig,
): { endpoint: string } | { error: string; message: string; docs: string } {
  const configured = normalizeOptionalString(liner?.baseUrl);
  if (!configured) {
    return { endpoint: `${LINER_BASE_URL}${LINER_SEARCH_PATHNAME}` };
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
  parsed.pathname = pathname.endsWith(LINER_SEARCH_PATHNAME)
    ? pathname
    : `${pathname === "" ? "" : pathname}${LINER_SEARCH_PATHNAME}`;
  parsed.hash = "";
  return { endpoint: parsed.toString() };
}

function missingLinerKeyPayload() {
  return {
    error: "missing_liner_api_key",
    message:
      "web_search (liner) needs a Liner API key. Set LINER_API_KEY in the Gateway environment, or configure plugins.entries.liner.config.webSearch.apiKey.",
    docs: "https://docs.openclaw.ai/tools/liner-search",
  };
}

function invalidQueryPayload() {
  return {
    error: "invalid_query",
    message: "query must be a non-empty string.",
    docs: "https://docs.openclaw.ai/tools/liner-search",
  };
}

export function resolveLinerSearchCount(value: number): number {
  return Math.max(1, Math.min(LINER_MAX_SEARCH_COUNT, Math.floor(value)));
}

export function normalizeLinerResults(payload: unknown): LinerSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as LinerSearchResponse).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter((entry): entry is LinerSearchResult =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

/** Maps a Liner `/api/v1/search/web` response into wrapped `web_search` results. */
export function mapLinerResults(response: LinerSearchResponse): Record<string, unknown>[] {
  return normalizeLinerResults(response)
    .filter((entry) => typeof entry.url === "string" && entry.url.length > 0)
    .map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : "";
      const url = entry.url as string;
      const description = typeof entry.description === "string" ? entry.description : "";
      const published = typeof entry.date === "string" && entry.date ? entry.date : undefined;
      return Object.assign(
        {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: description ? wrapWebContent(description, "web_search") : "",
          siteName: resolveSiteName(url) || undefined,
        },
        published ? { published } : {},
      );
    });
}

export function buildLinerCacheKey(params: {
  endpoint: string;
  query: string;
  count: number;
}): string {
  return buildSearchCacheKey(["liner", params.endpoint, params.query, params.count]);
}

async function runLinerSearch(params: {
  apiKey: string;
  endpoint: string;
  query: string;
  maxResults: number;
  timeoutSeconds: number;
}): Promise<LinerSearchResponse> {
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
          "X-API-KEY": params.apiKey,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Liner API error (${res.status}): ${detail || res.statusText}`);
      }
      try {
        return (await res.json()) as LinerSearchResponse;
      } catch (cause) {
        throw new Error("Liner API returned malformed JSON", { cause });
      }
    },
  );
}

export async function executeLinerWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "liner",
    resolveProviderWebSearchPluginConfig(ctx.config, "liner"),
  ) as SearchConfigRecord | undefined;
  const linerConfig = resolveLinerConfig(searchConfig);
  const apiKey = resolveLinerApiKey(linerConfig);
  if (!apiKey) {
    return missingLinerKeyPayload();
  }
  const endpointResult = resolveLinerSearchEndpoint(linerConfig);
  if ("error" in endpointResult) {
    return endpointResult;
  }
  const endpoint = endpointResult.endpoint;

  // Accept both the generic `query` arg (operator CLI / generic web_search) and
  // a `q` alias; Liner's tool schema declares `query`.
  const query =
    normalizeOptionalString(readStringParam(args, "query")) ??
    normalizeOptionalString(readStringParam(args, "q"));
  if (!query) {
    return invalidQueryPayload();
  }

  const requestedCount =
    readNumberParam(args, "count", { integer: true }) ??
    (typeof searchConfig?.maxResults === "number" ? searchConfig.maxResults : undefined);
  // Always forward an explicit max_results so Liner matches OpenClaw's generic
  // web_search default of 5 rather than its own server-side default.
  const count = resolveLinerSearchCount(requestedCount ?? DEFAULT_SEARCH_COUNT);

  const cacheKey = buildLinerCacheKey({ endpoint, query, count });
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const response = await runLinerSearch({
    apiKey,
    endpoint,
    query,
    maxResults: count,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
  });
  const results = mapLinerResults(response);

  const payload: Record<string, unknown> = {
    query,
    provider: "liner",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "liner",
      wrapped: true,
    },
    results,
  };
  if (typeof response.requestId === "string") {
    payload.requestId = response.requestId;
  }

  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}

export const testing = {
  buildLinerCacheKey,
  mapLinerResults,
  missingLinerKeyPayload,
  normalizeLinerResults,
  resolveLinerApiKey,
  resolveLinerConfig,
  resolveLinerSearchCount,
  resolveLinerSearchEndpoint,
  USER_AGENT,
} as const;

export { testing as __testing };
