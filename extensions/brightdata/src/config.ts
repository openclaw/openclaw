import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInput } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export const DEFAULT_BRIGHTDATA_BASE_URL = "https://api.brightdata.com";
export const DEFAULT_BRIGHTDATA_UNLOCKER_ZONE = "mcp_unlocker";
export const DEFAULT_BRIGHTDATA_BROWSER_ZONE = "mcp_browser";
export const DEFAULT_BRIGHTDATA_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_BRIGHTDATA_SCRAPE_TIMEOUT_SECONDS = 60;
export const DEFAULT_BRIGHTDATA_POLLING_TIMEOUT_SECONDS = 600;

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

type BrightDataSearchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
      unlockerZone?: string;
      browserZone?: string;
      timeoutSeconds?: number;
      pollingTimeoutSeconds?: number;
    }
  | undefined;

type PluginEntryConfig =
  | {
      webSearch?: {
        apiKey?: unknown;
        baseUrl?: string;
        unlockerZone?: string;
        browserZone?: string;
        timeoutSeconds?: number;
        pollingTimeoutSeconds?: number;
      };
    }
  | undefined;

type BrightDataFetchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
      unlockerZone?: string;
      browserZone?: string;
      timeoutSeconds?: number;
      pollingTimeoutSeconds?: number;
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

export function resolveBrightDataSearchConfig(cfg?: OpenClawConfig): BrightDataSearchConfig {
  const pluginConfig = cfg?.plugins?.entries?.brightdata?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) {
    return pluginWebSearch;
  }
  const search = resolveSearchConfig(cfg);
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const brightdata = "brightdata" in search ? search.brightdata : undefined;
  if (!brightdata || typeof brightdata !== "object") {
    return undefined;
  }
  return brightdata as BrightDataSearchConfig;
}

export function resolveBrightDataFetchConfig(cfg?: OpenClawConfig): BrightDataFetchConfig {
  const fetch = resolveFetchConfig(cfg);
  if (!fetch || typeof fetch !== "object") {
    return undefined;
  }
  const brightdata = "brightdata" in fetch ? fetch.brightdata : undefined;
  if (!brightdata || typeof brightdata !== "object") {
    return undefined;
  }
  return brightdata as BrightDataFetchConfig;
}

function normalizeConfiguredSecret(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value,
      path,
    }),
  );
}

function readConfiguredString(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveBrightDataApiToken(cfg?: OpenClawConfig): string | undefined {
  const search = resolveBrightDataSearchConfig(cfg);
  const fetch = resolveBrightDataFetchConfig(cfg);
  return (
    normalizeConfiguredSecret(
      search?.apiKey,
      "plugins.entries.brightdata.config.webSearch.apiKey",
    ) ||
    normalizeConfiguredSecret(search?.apiKey, "tools.web.search.brightdata.apiKey") ||
    normalizeConfiguredSecret(fetch?.apiKey, "tools.web.fetch.brightdata.apiKey") ||
    normalizeSecretInput(process.env.BRIGHTDATA_API_TOKEN) ||
    undefined
  );
}

export function resolveBrightDataBaseUrl(cfg?: OpenClawConfig): string {
  const search = resolveBrightDataSearchConfig(cfg);
  const fetch = resolveBrightDataFetchConfig(cfg);
  const configured =
    readConfiguredString(search?.baseUrl) ||
    readConfiguredString(fetch?.baseUrl) ||
    normalizeSecretInput(process.env.BRIGHTDATA_BASE_URL) ||
    "";
  return configured || DEFAULT_BRIGHTDATA_BASE_URL;
}

export function resolveBrightDataUnlockerZone(cfg?: OpenClawConfig): string {
  const search = resolveBrightDataSearchConfig(cfg);
  const fetch = resolveBrightDataFetchConfig(cfg);
  const configured =
    readConfiguredString(search?.unlockerZone) ||
    readConfiguredString(fetch?.unlockerZone) ||
    normalizeSecretInput(process.env.BRIGHTDATA_UNLOCKER_ZONE) ||
    "";
  return configured || DEFAULT_BRIGHTDATA_UNLOCKER_ZONE;
}

export function resolveBrightDataBrowserZone(cfg?: OpenClawConfig): string {
  const search = resolveBrightDataSearchConfig(cfg);
  const fetch = resolveBrightDataFetchConfig(cfg);
  const configured =
    readConfiguredString(search?.browserZone) ||
    readConfiguredString(fetch?.browserZone) ||
    normalizeSecretInput(process.env.BRIGHTDATA_BROWSER_ZONE) ||
    "";
  return configured || DEFAULT_BRIGHTDATA_BROWSER_ZONE;
}

export function resolveBrightDataSearchTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_BRIGHTDATA_SEARCH_TIMEOUT_SECONDS;
}

export function resolveBrightDataBrowserTimeoutSeconds(
  cfg?: OpenClawConfig,
  override?: number,
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const search = resolveBrightDataSearchConfig(cfg);
  const fetch = resolveBrightDataFetchConfig(cfg);
  if (
    typeof search?.timeoutSeconds === "number" &&
    Number.isFinite(search.timeoutSeconds) &&
    search.timeoutSeconds > 0
  ) {
    return Math.floor(search.timeoutSeconds);
  }
  if (
    typeof fetch?.timeoutSeconds === "number" &&
    Number.isFinite(fetch.timeoutSeconds) &&
    fetch.timeoutSeconds > 0
  ) {
    return Math.floor(fetch.timeoutSeconds);
  }
  return DEFAULT_BRIGHTDATA_SEARCH_TIMEOUT_SECONDS;
}

export function resolveBrightDataScrapeTimeoutSeconds(
  cfg?: OpenClawConfig,
  override?: number,
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const fetch = resolveBrightDataFetchConfig(cfg);
  const search = resolveBrightDataSearchConfig(cfg);
  if (
    typeof fetch?.timeoutSeconds === "number" &&
    Number.isFinite(fetch.timeoutSeconds) &&
    fetch.timeoutSeconds > 0
  ) {
    return Math.floor(fetch.timeoutSeconds);
  }
  if (
    typeof search?.timeoutSeconds === "number" &&
    Number.isFinite(search.timeoutSeconds) &&
    search.timeoutSeconds > 0
  ) {
    return Math.floor(search.timeoutSeconds);
  }
  return DEFAULT_BRIGHTDATA_SCRAPE_TIMEOUT_SECONDS;
}

export function resolveBrightDataPollingTimeoutSeconds(cfg?: OpenClawConfig): number {
  const fetch = resolveBrightDataFetchConfig(cfg);
  const search = resolveBrightDataSearchConfig(cfg);
  if (
    typeof fetch?.pollingTimeoutSeconds === "number" &&
    Number.isFinite(fetch.pollingTimeoutSeconds) &&
    fetch.pollingTimeoutSeconds > 0
  ) {
    return Math.floor(fetch.pollingTimeoutSeconds);
  }
  if (
    typeof search?.pollingTimeoutSeconds === "number" &&
    Number.isFinite(search.pollingTimeoutSeconds) &&
    search.pollingTimeoutSeconds > 0
  ) {
    return Math.floor(search.pollingTimeoutSeconds);
  }
  return DEFAULT_BRIGHTDATA_POLLING_TIMEOUT_SECONDS;
}
