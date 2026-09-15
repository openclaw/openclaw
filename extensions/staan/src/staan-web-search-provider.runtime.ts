// Staan provider module implements model/runtime integration.
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
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
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const STAAN_SEARCH_ENDPOINT = "https://api.staan.ai/v2/search/web";
const STAAN_PAGE_SIZE = 10;
const STAAN_MAX_DOMAIN_FILTERS = 10;
const STAAN_MAX_SNIPPETS = 10;
const STAAN_DEFAULT_MARKET = "en-gb";
const STAAN_MARKETS = [
  "en-gb",
  "en-us",
  "en-au",
  "en-ca",
  "en-ie",
  "en-in",
  "en-nz",
  "en-sg",
  "en-za",
  "en-fr",
  "fr-fr",
  "de-de",
] as const;
const STAAN_CONTENT_FORMATS = ["markdown", "html"] as const;
const STAAN_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
// Staan responses are untrusted external bodies. Cap the success JSON the same
// way other bundled providers do (16 MiB) so a misbehaving or hostile endpoint
// cannot stream an unbounded body into memory before we parse it. full_content
// makes a large body the normal case rather than the pathological one.
const STAAN_SEARCH_JSON_MAX_BYTES = 16 * 1024 * 1024;
const STAAN_DOCS_URL = "https://docs.openclaw.ai/tools/web";

type StaanMarket = (typeof STAAN_MARKETS)[number];
type StaanContentFormat = (typeof STAAN_CONTENT_FORMATS)[number];

type StaanConfig = {
  apiKey?: string;
  baseUrl?: string;
  market?: string;
};

type StaanSnippet = { text: string; score?: number };

type StaanExtraSnippet = {
  chunk?: unknown;
  score?: unknown;
};

type StaanSearchResult = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  hostname?: unknown;
  display_url?: unknown;
  published_date?: unknown;
  extra_snippets?: unknown;
  full_content?: unknown;
};

type ErrorPayload = { error: string; message: string; docs: string };

function errorPayload(error: string, message: string): ErrorPayload {
  return { error, message, docs: STAAN_DOCS_URL };
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return Boolean(
    value && typeof value === "object" && "error" in value && "message" in value && "docs" in value,
  );
}

function resolveStaanConfig(searchConfig?: SearchConfigRecord): StaanConfig {
  const staan = searchConfig?.staan;
  return staan && typeof staan === "object" && !Array.isArray(staan) ? (staan as StaanConfig) : {};
}

function resolveStaanApiKey(staan?: StaanConfig): string | undefined {
  return (
    readConfiguredSecretString(staan?.apiKey, "plugins.entries.staan.config.webSearch.apiKey") ??
    readProviderEnvValue(["STAAN_API_KEY"])
  );
}

function invalidBaseUrlPayload(value: string): ErrorPayload {
  return {
    error: "invalid_base_url",
    message: `plugins.entries.staan.config.webSearch.baseUrl must be a valid http(s) URL. Got: ${value}`,
    docs: "https://docs.openclaw.ai/tools/staan-search",
  };
}

function resolveStaanSearchEndpoint(staan?: StaanConfig): { endpoint: string } | ErrorPayload {
  const configured = normalizeOptionalString(staan?.baseUrl);
  if (!configured) {
    return { endpoint: STAAN_SEARCH_ENDPOINT };
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
  parsed.pathname = pathname.endsWith("/search/web")
    ? pathname
    : `${pathname === "" ? "" : pathname}/search/web`;
  parsed.hash = "";
  return { endpoint: parsed.toString() };
}

function resolveStaanMarket(
  raw: string | undefined,
  configured: string | undefined,
): { market: StaanMarket } | ErrorPayload {
  const requested = normalizeOptionalString(raw)?.toLowerCase();
  if (requested) {
    if (!STAAN_MARKETS.includes(requested as StaanMarket)) {
      return errorPayload(
        "invalid_market",
        `market must be one of: ${STAAN_MARKETS.join(", ")}.`,
      );
    }
    return { market: requested as StaanMarket };
  }
  const fallback = normalizeOptionalString(configured)?.toLowerCase();
  if (fallback) {
    if (!STAAN_MARKETS.includes(fallback as StaanMarket)) {
      return {
        error: "invalid_market",
        message: `plugins.entries.staan.config.webSearch.market must be one of: ${STAAN_MARKETS.join(", ")}. Got: ${fallback}`,
        docs: "https://docs.openclaw.ai/tools/staan-search",
      };
    }
    return { market: fallback as StaanMarket };
  }
  return { market: STAAN_DEFAULT_MARKET };
}

function readDomainList(
  params: Record<string, unknown>,
  key: "include_domains" | "exclude_domains",
): { value?: string[] } | ErrorPayload {
  const raw = params[key];
  if (raw === undefined) {
    return {};
  }
  if (!Array.isArray(raw)) {
    return errorPayload("invalid_domain_filter", `${key} must be an array of domain strings.`);
  }
  const domains = raw
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (domains.length !== raw.length) {
    return errorPayload("invalid_domain_filter", `${key} entries must be non-empty strings.`);
  }
  if (domains.length > STAAN_MAX_DOMAIN_FILTERS) {
    return errorPayload(
      "invalid_domain_filter",
      `${key} accepts at most ${STAAN_MAX_DOMAIN_FILTERS} domains.`,
    );
  }
  return domains.length > 0 ? { value: domains } : {};
}

function readMinScore(params: Record<string, unknown>): { value?: number } | ErrorPayload {
  const raw = params.min_score;
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return errorPayload("invalid_min_score", "min_score must be a number between 0 and 1.");
  }
  return { value: raw };
}

function normalizeStaanResults(payload: unknown): StaanSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const web = (payload as { web?: unknown }).web;
  if (!web || typeof web !== "object") {
    return [];
  }
  const results = (web as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter((entry): entry is StaanSearchResult =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

async function readStaanSearchResults(response: Response): Promise<StaanSearchResult[]> {
  const bytes = await readResponseWithLimit(response, STAAN_SEARCH_JSON_MAX_BYTES, {
    onOverflow: ({ maxBytes }) => new Error(`Staan API response exceeds ${maxBytes} bytes`),
  });
  try {
    return normalizeStaanResults(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (cause) {
    throw new Error("Staan API returned malformed JSON", { cause });
  }
}

function resolveStaanSnippets(result: StaanSearchResult): StaanSnippet[] {
  if (!Array.isArray(result.extra_snippets)) {
    return [];
  }
  const snippets: StaanSnippet[] = [];
  for (const entry of result.extra_snippets) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const snippet = entry as StaanExtraSnippet;
    const text = normalizeOptionalString(snippet.chunk);
    if (!text) {
      continue;
    }
    // Omit score entirely rather than setting it undefined: the payload is
    // serialized to the model, and an explicit null score reads as "scored
    // zero" rather than "not scored".
    snippets.push(
      typeof snippet.score === "number" && Number.isFinite(snippet.score)
        ? { text, score: snippet.score }
        : { text },
    );
  }
  return snippets;
}

async function runStaanSearch(params: {
  apiKey: string;
  endpoint: string;
  body: Record<string, unknown>;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<StaanSearchResult[]> {
  return withTrustedWebSearchEndpoint(
    {
      url: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "x-staan-integration": "openclaw",
        },
        body: JSON.stringify(params.body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await readResponseTextLimited(res, STAAN_ERROR_BODY_LIMIT_BYTES);
        throw new Error(`Staan API error (${res.status}): ${detail || res.statusText}`);
      }
      return readStaanSearchResults(res);
    },
  );
}

function missingStaanKeyPayload(): ErrorPayload {
  return errorPayload(
    "missing_staan_api_key",
    "web_search (staan) needs a Staan API key. Set STAAN_API_KEY in the Gateway environment, or configure plugins.entries.staan.config.webSearch.apiKey.",
  );
}

export async function executeStaanWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "staan",
    resolveProviderWebSearchPluginConfig(ctx.config, "staan"),
  ) as SearchConfigRecord | undefined;
  const params = args;
  const staanConfig = resolveStaanConfig(searchConfig);
  const apiKey = resolveStaanApiKey(staanConfig);
  if (!apiKey) {
    return missingStaanKeyPayload();
  }
  const endpointResult = resolveStaanSearchEndpoint(staanConfig);
  if (isErrorPayload(endpointResult)) {
    return endpointResult;
  }
  const endpoint = endpointResult.endpoint;

  const query = readStringParam(params, "query", { required: true });

  const marketResult = resolveStaanMarket(readStringParam(params, "market"), staanConfig.market);
  if (isErrorPayload(marketResult)) {
    return marketResult;
  }
  const market = marketResult.market;

  const requestedCount =
    readPositiveIntegerParam(params, "count", {
      max: STAAN_PAGE_SIZE,
      message: `count must be an integer from 1 to ${STAAN_PAGE_SIZE}.`,
    }) ??
    searchConfig?.maxResults ??
    DEFAULT_SEARCH_COUNT;
  const count = Math.min(STAAN_PAGE_SIZE, Math.max(1, requestedCount));

  const rawOffset = params.offset;
  if (
    rawOffset !== undefined &&
    (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset < 0)
  ) {
    return errorPayload("invalid_offset", "offset must be a non-negative integer.");
  }
  const offset = typeof rawOffset === "number" ? rawOffset : undefined;

  const includeDomains = readDomainList(params, "include_domains");
  if (isErrorPayload(includeDomains)) {
    return includeDomains;
  }
  const excludeDomains = readDomainList(params, "exclude_domains");
  if (isErrorPayload(excludeDomains)) {
    return excludeDomains;
  }

  const minScore = readMinScore(params);
  if (isErrorPayload(minScore)) {
    return minScore;
  }

  const rawFullContent = readStringParam(params, "full_content");
  if (rawFullContent && !STAAN_CONTENT_FORMATS.includes(rawFullContent as StaanContentFormat)) {
    return errorPayload(
      "invalid_full_content",
      `full_content must be one of: ${STAAN_CONTENT_FORMATS.join(", ")}.`,
    );
  }

  const wantsSnippets = params.extra_snippets === true;
  const maxSnippets = readPositiveIntegerParam(params, "max_snippets", {
    max: STAAN_MAX_SNIPPETS,
    message: `max_snippets must be an integer from 1 to ${STAAN_MAX_SNIPPETS}.`,
  });

  const body: Record<string, unknown> = { q: query, market };
  if (offset !== undefined) {
    body.offset = offset;
  }
  if (wantsSnippets) {
    body.extra_snippets = true;
    if (maxSnippets !== undefined) {
      body.max_snippets = maxSnippets;
    }
    if (minScore.value !== undefined) {
      body.min_score = minScore.value;
    }
  }
  if (rawFullContent) {
    body.full_content = rawFullContent;
  }
  if (includeDomains.value) {
    body.include_domains = includeDomains.value;
  }
  if (excludeDomains.value) {
    body.exclude_domains = excludeDomains.value;
  }

  const cacheKey = buildSearchCacheKey(["staan", endpoint, JSON.stringify(body), count]);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const results = await runStaanSearch({
    apiKey,
    endpoint,
    body,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
    signal,
  });

  signal?.throwIfAborted();
  const payload = {
    query,
    provider: "staan",
    count: Math.min(results.length, count),
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "staan",
      wrapped: true,
    },
    results: results.slice(0, count).map((entry) => {
      const title = normalizeOptionalString(entry.title) ?? "";
      const url = normalizeOptionalString(entry.url) ?? "";
      const description = normalizeOptionalString(entry.snippet) ?? "";
      const published = normalizeOptionalString(entry.published_date);
      const snippets = resolveStaanSnippets(entry);
      const fullContent = normalizeOptionalString(entry.full_content);
      return Object.assign(
        {
          title: title ? wrapWebContent(title, `web_search`) : ``,
          url,
          description: description ? wrapWebContent(description, `web_search`) : ``,
          published,
          siteName:
            normalizeOptionalString(entry.hostname) || resolveSiteName(url) || undefined,
        },
        snippets.length > 0
          ? {
              snippets: snippets.map((snippet) =>
                Object.assign(
                  { text: wrapWebContent(snippet.text, `web_search`) },
                  snippet.score === undefined ? {} : { score: snippet.score },
                ),
              ),
            }
          : {},
        fullContent ? { content: wrapWebContent(fullContent, `web_search`) } : {},
      );
    }),
  };

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
