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
  return (
    resolved ?? {
      mode: "off",
      debugDump: false,
      minContentSize: 100,
      refTagFormat: "unicode",
    }
  );
}
