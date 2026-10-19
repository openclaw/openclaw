/**
 * Shared settings for Codex native web search from canonical config.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Whether native Codex search may use cached or live external web access. */
type CodexNativeSearchMode = "cached" | "live";
/** OpenAI search context-size hint for Codex native web search. */
type CodexNativeSearchContextSize = "low" | "medium" | "high";

/** Optional approximate user location for Codex native web search. */
type CodexNativeSearchUserLocation = {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
};

/** Normalized Codex native web-search settings. */
type ResolvedCodexNativeWebSearchConfig = {
  enabled: boolean;
  mode: CodexNativeSearchMode;
  allowedDomains?: string[];
  contextSize?: CodexNativeSearchContextSize;
  userLocation?: CodexNativeSearchUserLocation;
};

/** Resolve Codex native web-search config from OpenClaw tool settings. */
export function resolveCodexNativeWebSearchConfig(
  config: OpenClawConfig | undefined,
): ResolvedCodexNativeWebSearchConfig {
  const nativeConfig = config?.tools?.web?.search?.openaiCodex;
  return {
    enabled: nativeConfig?.enabled === true,
    mode: nativeConfig?.mode ?? "cached",
    allowedDomains: nativeConfig?.allowedDomains,
    contextSize: nativeConfig?.contextSize,
    userLocation: nativeConfig?.userLocation,
  };
}

/** Return concise prompt/status text for enabled Codex native search. */
export function describeCodexNativeWebSearch(
  config: OpenClawConfig | undefined,
): string | undefined {
  if (config?.tools?.web?.search?.enabled === false) {
    return undefined;
  }

  const nativeConfig = resolveCodexNativeWebSearchConfig(config);
  if (!nativeConfig.enabled) {
    return undefined;
  }
  return `Codex native search: ${nativeConfig.mode} for Codex-capable models`;
}
