import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
export const DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS = 60;

type TavilySearchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
    }
  | undefined;

type TavilyFetchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
    }
  | undefined;

type PluginEntryConfig = {
  webSearch?: {
    apiKey?: unknown;
    baseUrl?: string;
  };
  webFetch?: {
    apiKey?: unknown;
    baseUrl?: string;
  };
};

export function resolveTavilySearchConfig(cfg?: OpenClawConfig): TavilySearchConfig {
  const pluginConfig = cfg?.plugins?.entries?.tavily?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) {
    return pluginWebSearch;
  }
  return undefined;
}

export function resolveTavilyFetchConfig(cfg?: OpenClawConfig): TavilyFetchConfig {
  const pluginConfig = cfg?.plugins?.entries?.tavily?.config as PluginEntryConfig;
  const pluginWebFetch = pluginConfig?.webFetch;
  if (pluginWebFetch && typeof pluginWebFetch === "object" && !Array.isArray(pluginWebFetch)) {
    return pluginWebFetch;
  }
  return undefined;
}

function normalizeConfiguredSecret(value: unknown, path: string): string | undefined {
  return normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value,
      path,
    }),
  );
}

export function resolveTavilyApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = resolveTavilySearchConfig(cfg);
  return (
    normalizeConfiguredSecret(search?.apiKey, "plugins.entries.tavily.config.webSearch.apiKey") ||
    normalizeSecretInput(process.env.TAVILY_API_KEY) ||
    undefined
  );
}

export function resolveTavilyBaseUrl(cfg?: OpenClawConfig): string {
  const search = resolveTavilySearchConfig(cfg);
  const configured =
    (normalizeOptionalString(search?.baseUrl) ?? "") ||
    normalizeSecretInput(process.env.TAVILY_BASE_URL) ||
    "";
  return configured || DEFAULT_TAVILY_BASE_URL;
}

export function resolveTavilyFetchApiKey(
  cfg?: OpenClawConfig,
  fetchApiKey?: unknown,
): string | undefined {
  const fetch = resolveTavilyFetchConfig(cfg);
  return (
    normalizeConfiguredSecret(fetch?.apiKey, "plugins.entries.tavily.config.webFetch.apiKey") ||
    normalizeConfiguredSecret(fetchApiKey, "tools.web.fetch.tavily.apiKey") ||
    resolveTavilyApiKey(cfg)
  );
}

export function resolveTavilyFetchBaseUrl(cfg?: OpenClawConfig): string {
  const fetch = resolveTavilyFetchConfig(cfg);
  const override = normalizeOptionalString(fetch?.baseUrl) ?? "";
  return override || resolveTavilyBaseUrl(cfg);
}

export function resolveTavilySearchTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS;
}

export function resolveTavilyExtractTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS;
}
