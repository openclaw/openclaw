import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInput } from "openclaw/plugin-sdk/provider-auth";

export const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
export const DEFAULT_TAVILY_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_TAVILY_EXTRACT_TIMEOUT_SECONDS = 60;

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type TavilySearchConfig =
  | {
      apiKey?: unknown;
      baseUrl?: string;
    }
  | undefined;

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

type PluginEntryConfig = {
  webSearch?: {
    apiKey?: unknown;
    baseUrl?: string;
  };
};

export function resolveTavilySearchConfig(cfg?: OpenClawConfig): TavilySearchConfig {
  // Prefer the new plugin config path (plugins.entries.tavily.config.webSearch).
  const pluginConfig = cfg?.plugins?.entries?.tavily?.config as PluginEntryConfig;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) {
    return pluginWebSearch;
  }
  // Fall back to the legacy config path (tools.web.search.tavily).
  const search = resolveSearchConfig(cfg);
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const tavily = "tavily" in search ? search.tavily : undefined;
  if (!tavily || typeof tavily !== "object") {
    return undefined;
  }
  return tavily as TavilySearchConfig;
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
    normalizeConfiguredSecret(search?.apiKey, "tools.web.search.tavily.apiKey") ||
    normalizeSecretInput(process.env.TAVILY_API_KEY) ||
    undefined
  );
}

export function resolveTavilyBaseUrl(cfg?: OpenClawConfig): string {
  const search = resolveTavilySearchConfig(cfg);
  const configured =
    (typeof search?.baseUrl === "string" ? search.baseUrl.trim() : "") ||
    normalizeSecretInput(process.env.TAVILY_BASE_URL) ||
    "";
  return configured || DEFAULT_TAVILY_BASE_URL;
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
