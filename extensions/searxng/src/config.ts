import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search";

const PLUGIN_ID = "searxng";

export const DEFAULT_SEARXNG_BASE_URL = "http://localhost:5000";
export const DEFAULT_SEARXNG_COUNT = 10;
export const MAX_SEARXNG_COUNT = 100;
export const DEFAULT_SEARXNG_LANG = "en";
export const DEFAULT_SEARXNG_TIMEOUT_SECONDS = 30;

type SearXNGPluginConfig = {
  webSearch?: {
    baseUrl?: string;
    count?: number;
    lang?: string;
    categories?: string[];
  };
};

function resolveWebSearchConfig(config?: OpenClawConfig): SearXNGPluginConfig["webSearch"] {
  const raw = resolveProviderWebSearchPluginConfig(config, PLUGIN_ID) as
    | SearXNGPluginConfig
    | undefined;
  const webSearch = raw?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveSearXNGBaseUrl(config?: OpenClawConfig): string {
  const raw = resolveWebSearchConfig(config)?.baseUrl;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || DEFAULT_SEARXNG_BASE_URL;
}

export function resolveSearXNGCount(config?: OpenClawConfig): number {
  const raw = resolveWebSearchConfig(config)?.count;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_SEARXNG_COUNT;
  }
  return Math.max(1, Math.min(MAX_SEARXNG_COUNT, Math.floor(raw)));
}

export function resolveSearXNGLang(config?: OpenClawConfig): string {
  const raw = resolveWebSearchConfig(config)?.lang;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || DEFAULT_SEARXNG_LANG;
}

export function resolveSearXNGCategories(config?: OpenClawConfig): string[] | undefined {
  const raw = resolveWebSearchConfig(config)?.categories;
  return Array.isArray(raw) && raw.length > 0 ? raw : undefined;
}
