import type { AgentContextDedupConfig } from "../../../config/types.agent-defaults.js";
import type { DedupConfig, EffectiveDedupSettings } from "./deduper.js";

export function resolveDedupConfig(
  config: AgentContextDedupConfig | undefined,
): DedupConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    mode: config.mode === "on" ? "on" : "off",
    lcsMode: config.lcsMode === "on" ? "on" : "off",
    lcsMinSize: config.lcsMinSize ?? 50,
    sizeSimilarityThreshold: config.sizeSimilarityThreshold ?? 0.5,
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
  return {
    mode: resolved?.mode ?? "off",
    lcsMode: resolved?.lcsMode ?? "off",
    lcsMinSize: resolved?.lcsMinSize ?? 50,
    sizeSimilarityThreshold: resolved?.sizeSimilarityThreshold ?? 0.5,
    debugDump: resolved?.debugDump ?? false,
    minContentSize: resolved?.minContentSize ?? 100,
    refTagFormat: resolved?.refTagFormat ?? "unicode",
  };
}
