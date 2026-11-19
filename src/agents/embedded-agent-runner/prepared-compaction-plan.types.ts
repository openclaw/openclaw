import type { CompactionFactPreparation } from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import type {
  CompactionSettings,
  CompactionResult,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { ConversationEntryDescriptor } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { CompactionError } from "../../../packages/agent-core/src/harness/types.js";
import type { PreparedCompactionSafeguardFacts } from "../agent-hooks/compaction-safeguard-prepared.types.js";
import type { CompactionRequestConstraints } from "../sessions/compaction/request-budget.types.js";
import type { PreparedCompactionReplayOptions } from "./prepared-compaction-replay.types.js";

export type CompactionMessageSource = { seq: number; index: number };
export type CompactionSelections = {
  history: ConversationEntryDescriptor<CompactionMessageSource>[];
  turnPrefix: ConversationEntryDescriptor<CompactionMessageSource>[];
};

/** Serializable inputs only: the host retains inference, callbacks, and write authority. */
export type PreparedCompactionPlanOptions = CompactionRequestConstraints & {
  settings: CompactionSettings;
  requestState?: "unresolved";
  mode?: "manual" | "auto";
  replay?: PreparedCompactionReplayOptions;
  safeguard?: { recentTurnsPreserve?: number; qualityGuardEnabled: boolean };
};

export type PreparedCompactionPlan = {
  preparation: CompactionFactPreparation;
  selections: CompactionSelections;
  retainedSequences: number[];
  pendingEntryId?: string;
  requestBudget?: CompactionRequestConstraints["requestBudget"];
  requestTokenLimit?: number;
  safeguard?: PreparedCompactionSafeguardFacts;
  deterministic?: CompactionResult;
  deterministicError?: { code: CompactionError["code"]; message: string };
};

/** Baseline context replay accounting, not provider-plugin replay hook output. */
export type PreparedCompactionReplayMetrics = {
  messageCountOriginal: number;
  tokenCountOriginal: number | undefined;
  messageCountBefore: number;
  tokenCountBefore: number | undefined;
};
