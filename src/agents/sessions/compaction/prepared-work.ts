import type { PreparedCompactionFloor } from "../../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import type {
  compactWithoutSummary,
  CompactionPreparation,
} from "../../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { runCompactionSafeguard } from "../../agent-hooks/compaction-safeguard.js";
import type { CompactionRequestBudget } from "./request-budget.js";

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
    event: Parameters<typeof runCompactionSafeguard>[0],
    context: Parameters<typeof runCompactionSafeguard>[1],
  ) => ReturnType<typeof runCompactionSafeguard>;
};
