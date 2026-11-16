import type { PreparedCompactionFloor } from "../../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import type {
  compactWithoutSummary,
  CompactionPreparation,
} from "../../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { RunCompactionSafeguard } from "../../agent-hooks/compaction-safeguard-execution.types.js";
import type { CompactionRequestBudget } from "./preparation.types.js";

/** Only the embedded compactor's known builtin may consume worker-prepared metadata. */
export const preparedSessionCompactionWork: unique symbol = Symbol("preparedSessionCompactionWork");

export type PreparedSessionCompactionWork = {
  /** Private builtin input; absent full arrays are never sent to an ExtensionRunner. */
  preparation: CompactionPreparation;
  pendingEntryId?: string;
  requestBudget?: CompactionRequestBudget;
  requestTokenLimit?: number;
  summaryReplayTokenBudget?: number;
  floor: PreparedCompactionFloor;
  deterministic: () => ReturnType<typeof compactWithoutSummary>;
  execute: (
    event: Parameters<RunCompactionSafeguard>[0],
    context: Parameters<RunCompactionSafeguard>[1],
  ) => ReturnType<RunCompactionSafeguard>;
};
