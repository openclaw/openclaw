import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import {
  createProviderHttpError,
  normalizeBaseUrl,
  readProviderJsonObjectResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  externalContentStamp,
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readWebSearchApiKey,
  readWebSearchQueryAndCount,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderSetupContext,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isNativeMoonshotBaseUrl,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
} from "../provider-catalog.js";

const DEFAULT_KIMI_BASE_URL = MOONSHOT_BASE_URL;

type KimiConfig = {
  apiKey?: string;
  baseUrl?: string;
};

function resolveKimiBaseUrl(kimi?: KimiConfig, openClawConfig?: OpenClawConfig): string {
  const explicitBaseUrl = normalizeOptionalString(kimi?.baseUrl);
  if (explicitBaseUrl) {
    return normalizeBaseUrl(explicitBaseUrl) || DEFAULT_KIMI_BASE_URL;
  }

  const moonshotBaseUrl = openClawConfig?.models?.providers?.moonshot?.baseUrl;
  if (typeof moonshotBaseUrl === "string") {
    const normalizedMoonshotBaseUrl = normalizeBaseUrl(moonshotBaseUrl);
    if (normalizedMoonshotBaseUrl && isNativeMoonshotBaseUrl(normalizedMoonshotBaseUrl)) {
      return normalizedMoonshotBaseUrl;
    }
  }

  return DEFAULT_KIMI_BASE_URL;
}

function normalizeKimiResultDate(value: unknown): string | undefined {
  const date = normalizeOptionalString(value);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

export async function executeKimiWebSearchProviderTool(
  ctx: { config?: OpenClawConfig; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  opts?.signal?.throwIfAborted();
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "kimi",
    resolveProviderWebSearchPluginConfig(ctx.config, "moonshot"),
  );
  const unsupportedResponse = buildUnsupportedSearchFilterResponse(args, "kimi");
  if (unsupportedResponse) {
    return unsupportedResponse;
  }

  const kimiConfig: KimiConfig = asNonArrayRecord(searchConfig?.kimi);
  const apiKey = readWebSearchApiKey(
    kimiConfig.apiKey,
    "plugins.entries.moonshot.config.webSearch.apiKey",
    ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  );
  if (!apiKey) {
    return {
      error: "missing_kimi_api_key",
      message:
        "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure plugins.entries.moonshot.config.webSearch.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const { query, count: requestedCount } = readWebSearchQueryAndCount(args, searchConfig);
  const count = resolveSearchCount(requestedCount, DEFAULT_SEARCH_COUNT);
  const baseUrl = resolveKimiBaseUrl(kimiConfig, ctx.config);
  const cacheKey = buildSearchCacheKey(["kimi", sha256Hex(apiKey), query, baseUrl, count]);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const signal = opts?.signal;
  const results = await withTrustedWebSearchEndpoint(
    {
      url: `${baseUrl}/tools/search`,
      timeoutSeconds,
      signal,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ text_query: query, limit: count }),
      },
    },
    async (res) => {
      if (!res.ok) {
        throw await createProviderHttpError(res, "Kimi API error");
      }

      const data = await readProviderJsonObjectResponse(res, "Kimi API error");
      if (!Array.isArray(data.search_results)) {
        throw new Error("Kimi API error: malformed JSON response");
      }
      return data.search_results.slice(0, count).map((entry) => {
        const result = asNonArrayRecord(entry);
        const title = normalizeOptionalString(result.title);
        const url = normalizeOptionalString(result.url) ?? "";
        const description = normalizeOptionalString(result.snippet);
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: description ? wrapWebContent(description, "web_search") : "",
          // Provider metadata is page-controlled text; keep only values that cannot carry prose.
          published: normalizeKimiResultDate(result.date),
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  );
  opts?.signal?.throwIfAborted();
  const payload = {
    query,
    provider: "kimi",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: externalContentStamp("kimi"),
    results,
  };
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}

export async function runKimiSearchProviderSetup(
  ctx: WebSearchProviderSetupContext,
): Promise<WebSearchProviderSetupContext["config"]> {
  const existingPluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "moonshot");
  // Normalize trailing slashes so initialValue matches canonical option values.
  const normalizedBaseUrl = normalizeBaseUrl(
    normalizeOptionalString(existingPluginConfig?.baseUrl),
  );

  const isCustomBaseUrl = normalizedBaseUrl && !isNativeMoonshotBaseUrl(normalizedBaseUrl);
  const regionOptions: Array<{ value: string; label: string; hint?: string }> = [];
  if (isCustomBaseUrl) {
    regionOptions.push({
      value: normalizedBaseUrl,
      label: `Keep current (${normalizedBaseUrl})`,
      hint: "custom endpoint",
    });
  }
  regionOptions.push(
    {
      value: MOONSHOT_BASE_URL,
      label: "Moonshot API key (.ai)",
      hint: "api.moonshot.ai",
    },
    {
      value: MOONSHOT_CN_BASE_URL,
      label: "Moonshot API key (.cn)",
      hint: "api.moonshot.cn",
    },
  );

  const baseUrl = await ctx.prompter.select<string>({
    message: "Kimi API region",
    options: regionOptions,
    initialValue: normalizedBaseUrl || MOONSHOT_BASE_URL,
  });

  const next = { ...ctx.config };
  setProviderWebSearchPluginConfigValue(next, "moonshot", "baseUrl", baseUrl);
  return next;
}
