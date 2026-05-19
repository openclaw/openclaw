import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const SERPAPI_BASE_URL = "https://serpapi.com/search";
export const SERPAPI_CREDENTIAL_PATH = "plugins.entries.serpapi-search.config.webSearch.apiKey";
export const DEFAULT_SERPAPI_TIMEOUT_SECONDS = 30;
// Slightly under SerpApi's 1-hour server-side cache window so we refresh before it expires.
export const SERPAPI_CACHE_TTL_MS = 55 * 60_000;

type SerpApiConfig = {
  apiKey?: unknown;
  hl?: unknown;
};

export function resolveSerpApiPluginConfig(cfg?: OpenClawConfig): SerpApiConfig | undefined {
  return resolveProviderWebSearchPluginConfig(cfg, "serpapi-search") as SerpApiConfig | undefined;
}

export function resolveSerpApiKey(cfg?: OpenClawConfig): string | undefined {
  const pluginConfig = resolveSerpApiPluginConfig(cfg);
  return (
    readConfiguredSecretString(pluginConfig?.apiKey, SERPAPI_CREDENTIAL_PATH) ||
    readProviderEnvValue(["SERPAPI_API_KEY"]) ||
    undefined
  );
}

export function resolveSerpApiLanguage(cfg?: OpenClawConfig): string {
  const pluginConfig = resolveSerpApiPluginConfig(cfg);
  return normalizeOptionalString(pluginConfig?.hl)?.trim() || "en";
}
