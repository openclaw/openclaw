export const DEFAULT_SAFE_SEARCH = "1";
export const DEFAULT_LANGUAGE = "en-US";
export const DEFAULT_TIMEOUT_SECONDS = 15;
export const DEFAULT_MAX_RESULTS = 5;

/**
 * A curated list of reliable public SearXNG instances (tried in order).
 * Updated March 2026. Each instance runs SearXNG and exposes the JSON API.
 */
export const DEFAULT_INSTANCES = [
  "https://searx.be",
  "https://search.mdosch.de",
  "https://paulgo.io",
  "https://searx.tiekoetter.com",
  "https://search.sapti.me",
];

type PluginCfg = {
  plugins?: { entries?: Record<string, { config?: unknown }> };
};

type SearchWebConfig = {
  baseUrl?: string;
  language?: string;
  safeSearch?: string;
};

function getWebConfig(cfg?: PluginCfg): SearchWebConfig | undefined {
  const entry = cfg?.plugins?.entries?.searxng?.config as
    | { webSearch?: SearchWebConfig }
    | undefined;
  return entry?.webSearch;
}

export function resolveInstances(cfg?: PluginCfg): string[] {
  const baseUrl = getWebConfig(cfg)?.baseUrl?.trim();
  return baseUrl ? [baseUrl] : DEFAULT_INSTANCES;
}

export function resolveLanguage(cfg?: PluginCfg): string {
  return getWebConfig(cfg)?.language?.trim() || DEFAULT_LANGUAGE;
}

export function resolveSafeSearch(cfg?: PluginCfg): string {
  const val = getWebConfig(cfg)?.safeSearch;
  return val === "0" || val === "2" ? val : DEFAULT_SAFE_SEARCH;
}
