import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  ProviderHttpError,
  readProviderResponseErrorText,
  redactProviderResponseErrorText,
} from "openclaw/plugin-sdk/provider-http";
import {
  externalContentStamp,
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  parseIsoDateRange,
  readCachedSearchPayload,
  readPositiveIntegerParam,
  readWebSearchApiKey,
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
import {
  asOptionalObjectRecord,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const KEENABLE_SEARCH_ENDPOINT = "https://api.keenable.ai/v1/search";
const KEENABLE_DEFAULT_APP_TITLE = "OpenClaw";
const KEENABLE_SEARCH_MODES = ["pro", "realtime"] as const;
const KEENABLE_MAX_SEARCH_COUNT = 50;
const KEENABLE_MIN_SNIPPET_LENGTH = 180;
const KEENABLE_MAX_SNIPPET_LENGTH = 10_000;
const KEENABLE_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const KEENABLE_SEARCH_JSON_MAX_BYTES = 16 * 1024 * 1024;

function invalidBaseUrlPayload() {
  return {
    error: "invalid_base_url",
    message:
      "plugins.entries.keenable.config.webSearch.baseUrl must be a valid http(s) URL.",
    docs: "https://docs.openclaw.ai/tools/keenable-search",
  };
}

function resolveKeenableEndpoint(baseUrl?: string): string | Record<string, unknown> {
  if (!baseUrl) {
    return KEENABLE_SEARCH_ENDPOINT;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) && !/^https?:\/\//i.test(baseUrl)) {
    return invalidBaseUrlPayload();
  }
  const candidate = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalidBaseUrlPayload();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalidBaseUrlPayload();
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/v1/search") ? pathname : `${pathname}/v1/search`;
  parsed.hash = "";
  return parsed.toString();
}

function resolveKeenableAppTitle(config?: Record<string, unknown>): string {
  const configured = normalizeOptionalString(config?.appTitle);
  return configured || KEENABLE_DEFAULT_APP_TITLE;
}

export async function executeKeenableWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "keenable",
    resolveProviderWebSearchPluginConfig(ctx.config, "keenable"),
  ) as SearchConfigRecord | undefined;
  const keenableConfig = asOptionalObjectRecord(searchConfig?.keenable);
  const apiKey = readWebSearchApiKey(
    keenableConfig?.apiKey,
    "plugins.entries.keenable.config.webSearch.apiKey",
    ["KEENABLE_API_KEY"],
  );
  if (!apiKey) {
    return {
      error: "missing_keenable_api_key",
      message:
        "web_search (keenable) needs a Keenable API key (free signup includes 100k requests/month). Set KEENABLE_API_KEY in the Gateway environment, or configure plugins.entries.keenable.config.webSearch.apiKey.",
      docs: "https://docs.openclaw.ai/tools/keenable-search",
    };
  }

  const endpoint = resolveKeenableEndpoint(normalizeOptionalString(keenableConfig?.baseUrl));
  if (typeof endpoint !== "string") {
    return endpoint;
  }
  const appTitle = resolveKeenableAppTitle(keenableConfig);

  const query = readStringParam(args, "query", { required: true });
  const rawMode = readStringParam(args, "mode");
  const mode = KEENABLE_SEARCH_MODES.find((candidate) => candidate === rawMode) ?? "pro";
  if (rawMode && !KEENABLE_SEARCH_MODES.includes(rawMode as (typeof KEENABLE_SEARCH_MODES)[number])) {
    return {
      error: "invalid_mode",
      message: 'mode must be "pro" or "realtime".',
      docs: "https://docs.openclaw.ai/tools/keenable-search",
    };
  }

  const count =
    readPositiveIntegerParam(args, "count", {
      max: KEENABLE_MAX_SEARCH_COUNT,
      message: `count must be an integer from 1 to ${KEENABLE_MAX_SEARCH_COUNT}.`,
    }) ?? searchConfig?.maxResults;
  const resolvedCount = Math.min(
    KEENABLE_MAX_SEARCH_COUNT,
    parseStrictPositiveInteger(count) ?? DEFAULT_SEARCH_COUNT,
  );

  const snippetMaxLength = readPositiveIntegerParam(args, "snippet_max_length", {
    max: KEENABLE_MAX_SNIPPET_LENGTH,
    message: `snippet_max_length must be an integer from ${KEENABLE_MIN_SNIPPET_LENGTH} to ${KEENABLE_MAX_SNIPPET_LENGTH}.`,
  });
  if (
    snippetMaxLength !== undefined &&
    snippetMaxLength < KEENABLE_MIN_SNIPPET_LENGTH
  ) {
    return {
      error: "invalid_snippet_max_length",
      message: `snippet_max_length must be an integer from ${KEENABLE_MIN_SNIPPET_LENGTH} to ${KEENABLE_MAX_SNIPPET_LENGTH}.`,
      docs: "https://docs.openclaw.ai/tools/keenable-search",
    };
  }

  const site = readStringParam(args, "site");
  const queryTime = readStringParam(args, "query_time");

  const parsedPublishedRange = parseIsoDateRange({
    rawDateAfter: readStringParam(args, "published_after"),
    rawDateBefore: readStringParam(args, "published_before"),
    invalidDateAfterMessage: "published_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "published_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage:
      "published_after must be earlier than or equal to published_before.",
  });
  if ("error" in parsedPublishedRange) {
    return parsedPublishedRange;
  }

  const parsedAcquiredRange = parseIsoDateRange({
    rawDateAfter: readStringParam(args, "acquired_after"),
    rawDateBefore: readStringParam(args, "acquired_before"),
    invalidDateAfterMessage: "acquired_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "acquired_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "acquired_after must be earlier than or equal to acquired_before.",
  });
  if ("error" in parsedAcquiredRange) {
    return parsedAcquiredRange;
  }

  const cacheKey = buildSearchCacheKey([
    "keenable",
    sha256Hex(apiKey),
    endpoint,
    appTitle,
    mode,
    query,
    resolvedCount,
    site,
    queryTime,
    parsedPublishedRange.dateAfter,
    parsedPublishedRange.dateBefore,
    parsedAcquiredRange.dateAfter,
    parsedAcquiredRange.dateBefore,
    snippetMaxLength,
  ]);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const body: Record<string, unknown> = {
    query,
    mode,
    max_results: resolvedCount,
  };
  if (site) {
    body.site = site;
  }
  if (queryTime) {
    body.query_time = queryTime;
  }
  if (parsedPublishedRange.dateAfter) {
    body.published_after = parsedPublishedRange.dateAfter;
  }
  if (parsedPublishedRange.dateBefore) {
    body.published_before = parsedPublishedRange.dateBefore;
  }
  if (parsedAcquiredRange.dateAfter) {
    body.acquired_after = parsedAcquiredRange.dateAfter;
  }
  if (parsedAcquiredRange.dateBefore) {
    body.acquired_before = parsedAcquiredRange.dateBefore;
  }
  if (snippetMaxLength !== undefined) {
    body.max_snippet_length = snippetMaxLength;
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-Keenable-Title": appTitle,
  };
  const results = await withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      signal,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await readProviderResponseErrorText(
          res,
          KEENABLE_ERROR_BODY_LIMIT_BYTES,
          headers,
          signal,
        );
        throw new ProviderHttpError(
          `Keenable API error (${res.status}): ${detail || redactProviderResponseErrorText(res.statusText, headers)}`,
          { status: res.status },
        );
      }
      const bytes = await readResponseWithLimit(res, KEENABLE_SEARCH_JSON_MAX_BYTES, {
        onOverflow: ({ maxBytes: maxBytesLocal }) =>
          new Error(`Keenable API response exceeds ${maxBytesLocal} bytes`),
      });
      try {
        const payload: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        const rows = asOptionalObjectRecord(payload)?.results;
        return (Array.isArray(rows) ? rows.filter(isRecord) : []).slice(0, resolvedCount);
      } catch (cause) {
        throw new Error("Keenable API returned malformed JSON", { cause });
      }
    },
  );

  signal?.throwIfAborted();
  const payload = {
    query,
    provider: "keenable",
    mode,
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: externalContentStamp("keenable"),
    results: results.map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      const snippet =
        (typeof entry.snippet === "string" && entry.snippet) ||
        (typeof entry.description === "string" && entry.description) ||
        "";
      const published =
        typeof entry.published_at === "string" && entry.published_at
          ? entry.published_at
          : undefined;
      const acquired =
        typeof entry.acquired_at === "string" && entry.acquired_at ? entry.acquired_at : undefined;
      return Object.assign(
        {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: snippet ? wrapWebContent(snippet, "web_search") : "",
          published,
          siteName: resolveSiteName(url) || undefined,
        },
        acquired ? { acquired } : {},
      );
    }),
  };

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
