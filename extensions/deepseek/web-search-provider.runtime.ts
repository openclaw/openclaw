import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  mergeScopedSearchConfig,
  nativeWebSearchCodecs,
  postTrustedWebToolsJson,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDeepSeekModelKeyFallback } from "./model-credential.js";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";

export async function executeDeepSeekSearch(
  ctx: { config?: OpenClawConfig; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const query = readStringParam(args, "query", { required: true });
  if (Array.from(query).length > 128) {
    return {
      error: "invalid_query",
      message:
        "DeepSeek search queries must contain 1 to 128 Unicode characters. Shorten the query; it has not been sent.",
    };
  }
  const unsupported = [
    "country",
    "language",
    "freshness",
    "date_after",
    "date_before",
    "search_lang",
    "ui_lang",
    "domain_filter",
    "max_tokens",
    "max_tokens_per_page",
  ].find((key) => args[key] !== undefined);
  if (unsupported) {
    return {
      error: "unsupported_filter",
      message: `DeepSeek does not support the ${unsupported} parameter. Put site:, -site:, lang:, after:, or before: operators directly in query instead.`,
    };
  }
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "deepseek",
    resolveProviderWebSearchPluginConfig(ctx.config, "deepseek"),
  );
  const deepseek = asNonArrayRecord(searchConfig?.deepseek);
  const modelKey = resolveDeepSeekModelKeyFallback(ctx.config);
  const apiKey =
    readConfiguredSecretString(
      deepseek.apiKey,
      "plugins.entries.deepseek.config.webSearch.apiKey",
    ) ??
    readProviderEnvValue(["DEEPSEEK_API_KEY"]) ??
    (modelKey ? readConfiguredSecretString(modelKey.value, modelKey.path) : undefined);
  if (!apiKey) {
    return {
      error: "missing_deepseek_api_key",
      message:
        'web_search (deepseek) needs a DeepSeek API key. Configure plugins.entries.deepseek.config.webSearch.apiKey or set DEEPSEEK_API_KEY; for chat, DEEPSEEK_API_KEY outranks models.providers.deepseek.apiKey unless models.providers.deepseek.auth is "api-key". models.providers.deepseek.apiKey is reused only while that provider and its models use https://api.deepseek.com. Use web_fetch for a specific URL if you do not want to configure search.',
      docs: "https://docs.openclaw.ai/providers/deepseek#web-search",
    };
  }
  const count = resolveSearchCount(
    readPositiveIntegerParam(args, "count", {
      max: MAX_SEARCH_COUNT,
      message: "count must be an integer from 1 to 10.",
    }) ?? searchConfig?.maxResults,
    DEFAULT_SEARCH_COUNT,
  );
  // Account-scoped results must not survive a credential switch in the shared cache.
  const credentialScope = createHash("sha256").update(apiKey).digest("hex");
  const cacheKey = buildSearchCacheKey([
    "deepseek",
    JSON.stringify([query, count, credentialScope]),
  ]);
  const ttlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, ttlMs);
  if (cached) {
    return cached;
  }
  const start = Date.now();
  const { results, omittedResults } = await postTrustedWebToolsJson(
    {
      url: SEARCH_URL,
      apiKey,
      timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      signal,
      body: nativeWebSearchCodecs["deepseek.search"].request(SEARCH_URL, query, count).body,
      errorLabel: "DeepSeek",
    },
    async (response) => {
      const data = await readProviderJsonObjectResponse(response, "DeepSeek API error");
      return nativeWebSearchCodecs["deepseek.search"].readResults(data, count);
    },
  );
  signal?.throwIfAborted();
  // The shared web_search output boundary validates URLs/dates and wraps provider prose.
  const payload = {
    query,
    provider: "deepseek",
    count: results.length,
    results,
    tookMs: Date.now() - start,
    ...(omittedResults ? { truncated: true } : {}),
  };
  writeCachedSearchPayload(cacheKey, payload, ttlMs);
  return payload;
}
