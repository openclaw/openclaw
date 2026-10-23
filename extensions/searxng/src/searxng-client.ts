import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { ProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import {
  externalContentStamp,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  readCachedSearchPayload,
  readResponseText,
  resolveCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  resolveTimeoutSeconds,
  withSelfHostedWebSearchEndpoint,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { resolveReadOnlyEnvSecretRef } from "openclaw/plugin-sdk/secret-ref-readonly";
import {
  assertHttpUrlTargetsPrivateNetwork,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalObjectRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const SEARXNG_BASE_URL_ENV_VAR = "SEARXNG_BASE_URL";
const SEARXNG_BASE_URL_PATH = "plugins.entries.searxng.config.webSearch.baseUrl";
const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_RESPONSE_BYTES = 1_000_000;
type SearxngEndpointMode = "selfHosted" | "strict";

type SearxngResult = {
  url: string;
  title: string;
  content?: string;
  img_src?: string;
};

function normalizeBaseUrl(value: unknown): string | undefined {
  return normalizeSecretInput(value)?.replace(/\/+$/u, "") || undefined;
}

function resolveSearxngBaseUrl(config?: OpenClawConfig): string | undefined {
  const webSearch = resolveProviderWebSearchPluginConfig(config, "searxng");
  const resolved = resolveReadOnlyEnvSecretRef({
    value: webSearch?.baseUrl,
    path: SEARXNG_BASE_URL_PATH,
    cfg: config,
    expectedEnvId: SEARXNG_BASE_URL_ENV_VAR,
    normalizeValue: normalizeBaseUrl,
  });
  if (resolved.status === "available") {
    return resolved.value;
  }
  if (resolved.status === "blocked") {
    return undefined;
  }
  return normalizeBaseUrl(process.env[SEARXNG_BASE_URL_ENV_VAR]);
}

function normalizeSearxngResult(value: unknown): SearxngResult | null {
  const candidate = asOptionalObjectRecord(value);
  if (typeof candidate?.url !== "string" || typeof candidate.title !== "string") {
    return null;
  }

  return {
    url: candidate.url,
    title: candidate.title,
    content: typeof candidate.content === "string" ? candidate.content : undefined,
    img_src: typeof candidate.img_src === "string" ? candidate.img_src : undefined,
  };
}

function shouldRetryEmptyCategorySearchWithGeneral(categories: string | undefined): boolean {
  if (!categories) {
    return false;
  }
  const normalized = categories
    .split(",")
    .map((category) => category.trim().toLowerCase())
    .filter((category) => category.length > 0);
  return normalized.length > 0 && !normalized.includes("general");
}

async function searxngEndpointTargetsPrivateNetwork(url: URL): Promise<boolean> {
  if (isBlockedHostnameOrIp(url.hostname)) {
    return true;
  }
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, {
      policy: {
        allowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
      },
    });
    return pinned.addresses.every((address) => isPrivateIpAddress(address));
  } catch {
    return false;
  }
}

async function validateSearxngBaseUrl(baseUrl: string): Promise<SearxngEndpointMode> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("SearXNG base URL must be a valid http:// or https:// URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SearXNG base URL must use http:// or https://.");
  }

  if (parsed.protocol === "http:") {
    await assertHttpUrlTargetsPrivateNetwork(parsed.toString(), {
      dangerouslyAllowPrivateNetwork: true,
      errorMessage:
        "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    });
    return "selfHosted";
  }

  return (await searxngEndpointTargetsPrivateNetwork(parsed)) ? "selfHosted" : "strict";
}

function parseSearxngResponseText(text: string, count: number): SearxngResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("SearXNG returned invalid JSON.");
  }

  const rawResults = asOptionalObjectRecord(parsed)?.results;
  const results: SearxngResult[] = [];

  for (const rawResult of Array.isArray(rawResults) ? rawResults : []) {
    const result = normalizeSearxngResult(rawResult);
    if (result) {
      results.push(result);
    }
    if (results.length >= count) {
      break;
    }
  }

  return results;
}

export async function runSearxngSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  categories?: string;
  language?: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  params.signal?.throwIfAborted();
  const count = resolveSearchCount(
    params.count ?? params.config?.tools?.web?.search?.maxResults,
    DEFAULT_SEARCH_COUNT,
  );
  const categories =
    params.categories ??
    normalizeOptionalString(
      resolveProviderWebSearchPluginConfig(params.config, "searxng")?.categories,
    );
  const language =
    params.language ??
    normalizeOptionalString(
      resolveProviderWebSearchPluginConfig(params.config, "searxng")?.language,
    );
  const baseUrl = resolveSearxngBaseUrl(params.config);
  const timeoutSeconds = resolveTimeoutSeconds(
    params.config?.tools?.web?.search?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const cacheTtlMs = resolveCacheTtlMs(
    params.config?.tools?.web?.search?.cacheTtlMinutes,
    DEFAULT_CACHE_TTL_MINUTES,
  );

  if (!baseUrl) {
    throw new Error(
      "SearXNG base URL is not configured. Set SEARXNG_BASE_URL or configure plugins.entries.searxng.config.webSearch.baseUrl.",
    );
  }
  const endpointMode = await validateSearxngBaseUrl(baseUrl);
  params.signal?.throwIfAborted();

  const cacheKey = JSON.stringify({
    provider: "searxng",
    query: params.query,
    count,
    categories: categories ?? "",
    language: language ?? "",
    baseUrl,
  });
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const startedAt = Date.now();
  const query = params.query;
  const signal = params.signal;
  const fetchSearxngResults = async (
    searchCategories: string | undefined,
  ): Promise<SearxngResult[]> => {
    const url = new URL(baseUrl);
    const basePathname = url.pathname.replace(/\/+$/u, "");
    url.pathname = basePathname.endsWith("/search") ? basePathname : `${basePathname}/search`;
    url.search = "";
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    if (searchCategories) {
      url.searchParams.set("categories", searchCategories);
    }
    if (language) {
      url.searchParams.set("language", language);
    }

    const withEndpoint =
      endpointMode === "selfHosted"
        ? withSelfHostedWebSearchEndpoint
        : withTrustedWebSearchEndpoint;
    return await withEndpoint(
      {
        url: url.toString(),
        timeoutSeconds,
        signal,
        init: {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        },
      },
      async (response) => {
        if (!response.ok) {
          const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
          throw new ProviderHttpError(
            `SearXNG search error (${response.status}): ${detail || response.statusText}`,
            { status: response.status },
          );
        }

        const body = await readResponseText(response, { maxBytes: MAX_RESPONSE_BYTES });
        if (body.truncated) {
          throw new Error(`SearXNG response incomplete after ${body.bytesRead} bytes.`);
        }
        return parseSearxngResponseText(body.text, count);
      },
    );
  };
  let results = await fetchSearxngResults(categories);
  params.signal?.throwIfAborted();
  if (results.length === 0 && shouldRetryEmptyCategorySearchWithGeneral(categories)) {
    results = await fetchSearxngResults("general");
    params.signal?.throwIfAborted();
  }

  const payload = {
    query: params.query,
    provider: "searxng",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: externalContentStamp("searxng"),
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.content ? wrapWebContent(result.content, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
      img_src: result.img_src || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
