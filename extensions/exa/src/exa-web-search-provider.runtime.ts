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
  asOptionalRecord,
  isRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const EXA_SEARCH_TYPES = ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"] as const;
const EXA_FRESHNESS_VALUES = ["day", "week", "month", "year"] as const;
const EXA_MAX_SEARCH_COUNT = 100;
const EXA_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
// Exa search responses are untrusted external bodies. Cap the success JSON the
// same way other bundled providers do (16 MiB) so a misbehaving or hostile
// endpoint cannot stream an unbounded body into memory before we parse it.
const EXA_SEARCH_JSON_MAX_BYTES = 16 * 1024 * 1024;

type ExaTextContentsOption = boolean | { maxCharacters?: number };
type ExaHighlightsContentsOption =
  | boolean
  | {
      maxCharacters?: number;
      query?: string;
      numSentences?: number;
      highlightsPerUrl?: number;
    };
type ExaSummaryContentsOption = boolean | { query?: string };

type ExaContentsArgs = {
  highlights?: ExaHighlightsContentsOption;
  text?: ExaTextContentsOption;
  summary?: ExaSummaryContentsOption;
};

function invalidBaseUrlPayload() {
  return {
    error: "invalid_base_url",
    message: "plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL.",
    docs: "https://docs.openclaw.ai/tools/exa-search",
  };
}

function invalidContentsPayload(message: string) {
  return {
    error: "invalid_contents",
    message,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

export async function executeExaWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "exa",
    resolveProviderWebSearchPluginConfig(ctx.config, "exa"),
  ) as SearchConfigRecord | undefined;
  const exaConfig = asOptionalRecord(searchConfig?.exa);
  const apiKey = readWebSearchApiKey(
    exaConfig?.apiKey,
    "plugins.entries.exa.config.webSearch.apiKey",
    ["EXA_API_KEY"],
  );
  if (!apiKey) {
    return {
      error: "missing_exa_api_key",
      message:
        "web_search (exa) needs an Exa API key. Set EXA_API_KEY in the Gateway environment, or configure plugins.entries.exa.config.webSearch.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  let endpoint = EXA_SEARCH_ENDPOINT;
  const configured = normalizeOptionalString(exaConfig?.baseUrl);
  if (configured) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(configured) && !/^https?:\/\//i.test(configured)) {
      return invalidBaseUrlPayload();
    }
    const candidate = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
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
    parsed.pathname = pathname.endsWith("/search") ? pathname : `${pathname}/search`;
    parsed.hash = "";
    endpoint = parsed.toString();
  }

  const query = readStringParam(args, "query", { required: true });
  const rawType = readStringParam(args, "type");
  const type = EXA_SEARCH_TYPES.find((candidate) => candidate === rawType) ?? "auto";
  const count =
    readPositiveIntegerParam(args, "count", {
      max: EXA_MAX_SEARCH_COUNT,
      message: `count must be an integer from 1 to ${EXA_MAX_SEARCH_COUNT}.`,
    }) ?? searchConfig?.maxResults;
  const rawFreshness = readStringParam(args, "freshness");
  const normalizedFreshness = normalizeOptionalLowercaseString(rawFreshness);
  const freshness = EXA_FRESHNESS_VALUES.find((value) => value === normalizedFreshness);
  if (rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: 'freshness must be one of "day", "week", "month", or "year".',
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  if (freshness && (rawDateAfter || rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message:
        "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  const parsedDateRange = parseIsoDateRange({
    rawDateAfter,
    rawDateBefore,
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be earlier than or equal to date_before.",
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }
  const { dateAfter, dateBefore } = parsedDateRange;

  const parsedContents: ExaContentsArgs = {};
  const rawContents = args.contents;
  if (rawContents !== undefined) {
    if (!isRecord(rawContents)) {
      return invalidContentsPayload(
        "contents must be an object with optional text, highlights, and summary fields.",
      );
    }
    const allowedKeys = new Set(["text", "highlights", "summary"]);
    for (const key of Object.keys(rawContents)) {
      if (!allowedKeys.has(key)) {
        return invalidContentsPayload(
          `contents has unknown field "${key}". Only "text", "highlights", and "summary" are allowed.`,
        );
      }
    }
    const fieldsBySection = {
      text: ["maxCharacters"],
      highlights: ["maxCharacters", "query", "numSentences", "highlightsPerUrl"],
      summary: ["query"],
    } as const;
    for (const section of ["text", "highlights", "summary"] as const) {
      if (!(section in rawContents)) {
        continue;
      }
      const value = rawContents[section];
      if (typeof value === "boolean") {
        parsedContents[section] = value;
        continue;
      }
      if (!isRecord(value)) {
        return invalidContentsPayload(`contents.${section} must be a boolean or an object.`);
      }
      const option = value;
      const fields: readonly string[] = fieldsBySection[section];
      for (const key of Object.keys(option)) {
        if (!fields.includes(key)) {
          const allowed =
            section === "highlights"
              ? 'Allowed fields are "maxCharacters", "query", "numSentences", and "highlightsPerUrl".'
              : `Only "${fields[0]}" is allowed.`;
          return invalidContentsPayload(
            `contents.${section} has unknown field "${key}". ${allowed}`,
          );
        }
      }
      for (const field of fields) {
        if (
          field !== "query" &&
          field in option &&
          !(
            typeof option[field] === "number" &&
            Number.isInteger(option[field]) &&
            option[field] > 0
          )
        ) {
          return invalidContentsPayload(`contents.${section}.${field} must be a positive integer.`);
        }
      }
      if (section !== "text" && "query" in option && typeof option.query !== "string") {
        return invalidContentsPayload(`contents.${section}.query must be a string.`);
      }
      const normalized: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in option) {
          normalized[field] = option[field];
        }
      }
      Object.assign(parsedContents, { [section]: normalized });
    }
  }
  const contents = Object.keys(parsedContents).length > 0 ? parsedContents : undefined;

  const resolvedCount = Math.min(
    EXA_MAX_SEARCH_COUNT,
    parseStrictPositiveInteger(count) ?? DEFAULT_SEARCH_COUNT,
  );
  const cacheKey = buildSearchCacheKey([
    "exa",
    sha256Hex(apiKey),
    endpoint,
    type,
    query,
    resolvedCount,
    freshness,
    dateAfter,
    dateBefore,
    JSON.stringify(contents ?? { highlights: true }),
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
    numResults: resolvedCount,
    type,
    contents: contents ?? { highlights: true },
  };

  if (dateAfter) {
    body.startPublishedDate = dateAfter;
  } else if (freshness) {
    const now = new Date();
    if (freshness === "day") {
      now.setUTCDate(now.getUTCDate() - 1);
    } else if (freshness === "week") {
      now.setUTCDate(now.getUTCDate() - 7);
    } else if (freshness === "month") {
      const currentDay = now.getUTCDate();
      now.setUTCDate(1);
      now.setUTCMonth(now.getUTCMonth() - 1);
      const lastDayOfTargetMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
      ).getUTCDate();
      now.setUTCDate(Math.min(currentDay, lastDayOfTargetMonth));
    } else {
      now.setUTCFullYear(now.getUTCFullYear() - 1);
    }
    body.startPublishedDate = now.toISOString();
  }
  if (dateBefore) {
    body.endPublishedDate = dateBefore;
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-exa-integration": "openclaw",
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
          EXA_ERROR_BODY_LIMIT_BYTES,
          headers,
          signal,
        );
        throw new ProviderHttpError(
          `Exa API error (${res.status}): ${detail || redactProviderResponseErrorText(res.statusText, headers)}`,
          { status: res.status },
        );
      }
      const bytes = await readResponseWithLimit(res, EXA_SEARCH_JSON_MAX_BYTES, {
        onOverflow: ({ maxBytes: maxBytesLocal }) =>
          new Error(`Exa API response exceeds ${maxBytesLocal} bytes`),
      });
      try {
        const payload: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        const rows = asOptionalObjectRecord(payload)?.results;
        return (Array.isArray(rows) ? rows.filter(isRecord) : []).slice(0, resolvedCount);
      } catch (cause) {
        throw new Error("Exa API returned malformed JSON", { cause });
      }
    },
  );

  signal?.throwIfAborted();
  const payload = {
    query,
    provider: "exa",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: externalContentStamp("exa"),
    results: results.map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      const description =
        normalizeTrimmedStringList(entry.highlights).join("\n") ||
        normalizeOptionalString(entry.summary) ||
        normalizeOptionalString(entry.text) ||
        "";
      const summary = normalizeOptionalString(entry.summary) ?? "";
      const highlightScores = Array.isArray(entry.highlightScores)
        ? entry.highlightScores.filter(
            (score): score is number => typeof score === "number" && Number.isFinite(score),
          )
        : [];
      const published =
        typeof entry.publishedDate === "string" && entry.publishedDate
          ? entry.publishedDate
          : undefined;
      return Object.assign(
        {
          title: title ? wrapWebContent(title, `web_search`) : ``,
          url,
          description: description ? wrapWebContent(description, `web_search`) : ``,
          published,
          siteName: resolveSiteName(url) || undefined,
        },
        summary ? { summary: wrapWebContent(summary, `web_search`) } : {},
        highlightScores.length > 0 ? { highlightScores } : {},
      );
    }),
  };

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
