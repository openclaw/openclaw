import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_DDG_SAFE_SEARCH = "moderate";

export type DdgSafeSearch = "strict" | "moderate" | "off";

export function resolveDdgRegion(config?: OpenClawConfig): string | undefined {
  return normalizeOptionalString(
    resolveProviderWebSearchPluginConfig(config, "duckduckgo")?.region,
  );
}

export function resolveDdgSafeSearch(config?: OpenClawConfig): DdgSafeSearch {
  const safeSearch = resolveProviderWebSearchPluginConfig(config, "duckduckgo")?.safeSearch;
  const normalized = normalizeLowercaseStringOrEmpty(safeSearch);
  if (normalized === "strict" || normalized === "off") {
    return normalized;
  }
  return DEFAULT_DDG_SAFE_SEARCH;
}
