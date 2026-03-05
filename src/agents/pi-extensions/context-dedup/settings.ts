import type { AgentContextDedupConfig } from "../../../config/types.agent-defaults.js";
import type { DedupConfig, EffectiveDedupSettings } from "./deduper.js";
import type { LCSConfig } from "./lcs-dedup.js";

export function resolveDedupConfig(config: AgentContextDedupConfig | undefined): DedupConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    mode: config.mode === "on" ? "on" : "off",
    debugDump: config.debugDump ?? false,
    minContentSize: config.minContentSize ?? 100,
    refTagFormat: config.refTagFormat ?? "unicode",
  };
}

/**
 * Effective settings used by full-message dedup.
 */
export function resolveEffectiveDedupSettings(
  config: AgentContextDedupConfig | undefined,
): EffectiveDedupSettings {
  const resolved = resolveDedupConfig(config);
  return resolved ?? {
    mode: "off",
    debugDump: false,
    minContentSize: 100,
    refTagFormat: "unicode",
  };
}

/**
 * Sub-line/LCS dedup is intentionally disabled.
 * Keep the shape for compatibility with existing runtime wiring.
 */
export function resolveLCSSettings(
  config: AgentContextDedupConfig | undefined,
  refTagSize: number,
): LCSConfig {
  const minSubstringSize = Math.max(8, config?.lcsMinSize ?? 50);
  const maxSubstringSize = Math.max(minSubstringSize, 4096);

  return {
    mode: "off",
    minSubstringSize,
    maxSubstringSize,
    refTagSize,
    maxIterations: 1,
  };
}
