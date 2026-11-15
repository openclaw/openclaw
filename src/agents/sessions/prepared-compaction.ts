import {
  compactWithoutSummary,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionDetails,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { Result } from "../../../packages/agent-core/src/harness/types.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";
import type { PreparedCompaction } from "./prepared-compaction.types.js";

const registry = createSessionManagerRuntimeRegistry<PreparedCompaction>();
export const setPreparedCompaction = registry.set;
export const getPreparedCompaction = registry.get;

export function resolveCompactionFallback(
  preparation: CompactionPreparation,
  prepared: PreparedCompaction | null,
): Result<CompactionResult<CompactionDetails>, Error> {
  return compactWithoutSummary(preparation, prepared?.fallback);
}
