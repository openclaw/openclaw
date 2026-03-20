export const DEFAULT_DDG_SEARCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_DDG_SAFE_SEARCH = "moderate";

type DdgSearchConfig =
  | {
      region?: string;
      safeSearch?: string;
    }
  | undefined;

type PluginEntryConfig = {
  webSearch?: {
    region?: string;
    safeSearch?: string;
  };
};

export function resolveDdgSearchConfig(cfg?: {
  plugins?: { entries?: Record<string, { config?: unknown }> };
}): DdgSearchConfig {
  const pluginConfig = cfg?.plugins?.entries?.duckduckgo?.config as
    | PluginEntryConfig
    | undefined;
  const pluginWebSearch = pluginConfig?.webSearch;
  if (
    pluginWebSearch &&
    typeof pluginWebSearch === "object" &&
    !Array.isArray(pluginWebSearch)
  ) {
    return pluginWebSearch;
  }
  return undefined;
}

export function resolveDdgRegion(cfg?: {
  plugins?: { entries?: Record<string, { config?: unknown }> };
}): string | undefined {
  const search = resolveDdgSearchConfig(cfg);
  return typeof search?.region === "string" && search.region.trim()
    ? search.region.trim()
    : undefined;
}

export function resolveDdgSafeSearch(cfg?: {
  plugins?: { entries?: Record<string, { config?: unknown }> };
}): string {
  const search = resolveDdgSearchConfig(cfg);
  const value = typeof search?.safeSearch === "string" ? search.safeSearch.trim().toLowerCase() : "";
  if (value === "strict" || value === "off") {
    return value;
  }
  return DEFAULT_DDG_SAFE_SEARCH;
}

export function resolveDdgSearchTimeoutSeconds(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_DDG_SEARCH_TIMEOUT_SECONDS;
}
