import { resolveRunModelFallbacksOverride } from "../agent-scope.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";

/** Resolve compaction fallbacks while keeping any already-selected agent. */
export function resolveCompactionFallbacksOverride(
  params: CompactEmbeddedAgentSessionParams,
): string[] | undefined {
  if (params.modelSelectionLocked) {
    return [];
  }
  return (
    params.modelFallbacksOverride ??
    resolveRunModelFallbacksOverride({
      cfg: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    })
  );
}
