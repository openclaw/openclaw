import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";

export const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
export const DEFAULT_FIRECRAWL_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_SECONDS = 60;
export const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type WebFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type FirecrawlSearchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
    }
  | undefined;

type PluginEntryConfig =
  | {
      webSearch?: {
        apiKey?: unknown;
        baseUrl?: string;
      };
    }
  | undefined;

type FirecrawlFetchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
      onlyMainContent?: boolean;
      maxAgeMs?: number;
      timeoutSeconds?: number;
    }
  | undefined;

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveFetchConfig(cfg?: OpenClawConfig): WebFetchConfig {
  const fetch = cfg?.tools?.web?.fetch;
  if (!fetch || typeof fetch !== "object") {
    return undefined;
  }
  return fetch as WebFetchConfig;
}

export function resolveFirecrawlSearchConfig(cfg?: OpenClawConfig): FirecrawlSearchConfig {
  const pluginConfig = cfg?.plugins?.entries?.firecrawl?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) {
    return pluginWebSearch;
  }
  const search = resolveSearchConfig(cfg);
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const firecrawl = "firecrawl" in search ? search.firecrawl : undefined;
  if (!firecrawl || typeof firecrawl !== "object") {
    return undefined;
  }
  return firecrawl as FirecrawlSearchConfig;
}

export function resolveFirecrawlFetchConfig(cfg?: OpenClawConfig): FirecrawlFetchConfig {
  const fetch = resolveFetchConfig(cfg);
  if (!fetch || typeof fetch !== "object") {
    return undefined;
  }
  const firecrawl = "firecrawl" in fetch ? fetch.firecrawl : undefined;
  if (!firecrawl || typeof firecrawl !== "object") {
    return undefined;
  }
  return firecrawl as FirecrawlFetchConfig;
}

function normalizeConfiguredSecret(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value,
      path,
    }),
  );
}

export function resolveFirecrawlApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = resolveFirecrawlSearchConfig(cfg);
  const fetch = resolveFirecrawlFetchConfig(cfg);
  return (
    normalizeConfiguredSecret(
      search?.apiKey,
      "plugins.entries.firecrawl.config.webSearch.apiKey",
    ) ||
    normalizeConfiguredSecret(search?.apiKey, "tools.web.search.firecrawl.apiKey") ||
    normalizeConfiguredSecret(fetch?.apiKey, "tools.web.fetch.firecrawl.apiKey") ||
    normalizeSecretInput(process.env.FIRECRAWL_API_KEY) ||
    undefined
  );
}

export function resolveFirecrawlBaseUrl(cfg?: OpenClawConfig): string {
  const search = resolveFirecrawlSearchConfig(cfg);
  const fetch = resolveFirecrawlFetchConfig(cfg);
  const configured =
    (typeof search?.baseUrl === "string" ? search.baseUrl.trim() : "") ||
    (typeof fetch?.baseUrl === "string" ? fetch.baseUrl.trim() : "") ||
    normalizeSecretInput(process.env.FIRECRAWL_BASE_URL) ||
    "";
  return configured || DEFAULT_FIRECRAWL_BASE_URL;
}

export function resolveFirecrawlOnlyMainContent(cfg?: OpenClawConfig, override?: boolean): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  const fetch = resolveFirecrawlFetchConfig(cfg);
  if (typeof fetch?.onlyMainContent === "boolean") {
    return fetch.onlyMainContent;
  }
  return true;
}

export function resolveFirecrawlMaxAgeMs(cfg?: OpenClawConfig, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const fetch = resolveFirecrawlFetchConfig(cfg);
  if (
    typeof fetch?.maxAgeMs === "number" &&
    Number.isFinite(fetch.maxAgeMs) &&
    fetch.maxAgeMs >= 0
  ) {
    return Math.floor(fetch.maxAgeMs);
  }
  return DEFAULT_FIRECRAWL_MAX_AGE_MS;
}

export function resolveFirecrawlScrapeTimeoutSeconds(
  cfg?: OpenClawConfig,
  override?: number,
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const fetch = resolveFirecrawlFetchConfig(cfg);
  if (
    typeof fetch?.timeoutSeconds === "number" &&
    Number.isFinite(fetch.timeoutSeconds) &&
    fetch.timeoutSeconds > 0
  ) {
    return Math.floor(fetch.timeoutSeconds);
  }
  return DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_SECONDS;
}

export function resolveFirecrawlSearchTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_FIRECRAWL_SEARCH_TIMEOUT_SECONDS;
}
