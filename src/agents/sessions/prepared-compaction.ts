import {
  compactWithoutSummary,
  type CompactionPreparation,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import type { PreparedCompaction } from "./prepared-compaction.types.js";

const registry = createSessionManagerRuntimeRegistry<PreparedCompaction>();
export const setPreparedCompaction = registry.set;
export const getPreparedCompaction = registry.get;

export function resolveCompactionFallback(
  preparation: CompactionPreparation,
  prepared: PreparedCompaction | null,
) {
  if (!prepared) {
    const fallback = compactWithoutSummary(preparation);
    if (!fallback.ok) {
      throw fallback.error;
    }
    return fallback.value;
  }
  if (!prepared.fallback) {
    throw new Error(
      prepared.fallbackError ?? "Prepared compaction cannot fit its fallback summary",
    );
  }
  return prepared.fallback;
}
