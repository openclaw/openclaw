/**
 * Shared settings for Codex native web search from canonical config.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Resolve Codex native web-search config from OpenClaw tool settings. */
export function resolveCodexNativeWebSearchConfig(config: OpenClawConfig | undefined) {
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
