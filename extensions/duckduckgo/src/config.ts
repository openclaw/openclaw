import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_DDG_SAFE_SEARCH = "moderate";

export type DdgSafeSearch = "strict" | "moderate" | "off";

function resolveDdgWebSearchConfig(config?: OpenClawConfig) {
  return asOptionalRecord(config?.plugins?.entries?.duckduckgo?.config?.webSearch);
}

export function resolveDdgRegion(config?: OpenClawConfig): string | undefined {
  return normalizeOptionalString(resolveDdgWebSearchConfig(config)?.region);
}

export function resolveDdgSafeSearch(config?: OpenClawConfig): DdgSafeSearch {
  const safeSearch = resolveDdgWebSearchConfig(config)?.safeSearch;
  const normalized = normalizeLowercaseStringOrEmpty(safeSearch);
  if (normalized === "strict" || normalized === "off") {
    return normalized;
  }
  return DEFAULT_DDG_SAFE_SEARCH;
}
