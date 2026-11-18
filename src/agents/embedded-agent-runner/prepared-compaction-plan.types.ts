import type { PreparedCompactionFloor } from "../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import type {
  CompactionPreparation,
  compactWithoutSummary,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { ConversationEntryDescriptor } from "../../../packages/agent-core/src/harness/compaction/conversation-serialization.js";
import type { PreparedCompactionSafeguardFacts } from "../agent-hooks/compaction-safeguard-prepared.types.js";
import type { AgentCompactionPreparationOptions } from "../sessions/compaction/preparation.types.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";

export type PreparedCompactionPlanOptions = {
  work: AgentCompactionPreparationOptions;
  recentTurnsPreserve?: number;
  qualityGuardEnabled: boolean;
};

/** Private builtin-only metadata; not an ExtensionRunner or public SDK preparation. */
export type PreparedCompactionPlan = {
  preparation: Omit<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages">;
  facts: PreparedCompactionSafeguardFacts;
  floor: PreparedCompactionFloor;
  deterministic: Extract<ReturnType<typeof compactWithoutSummary>, { ok: true }>["value"];
  pendingEntryId?: string;
  requestBudget?: AgentCompactionPreparationOptions["requestBudget"];
  requestTokenLimit?: number;
  summaryReplayTokenBudget?: number;
  selections: { history: ConversationEntryDescriptor[]; turnPrefix: ConversationEntryDescriptor[] };
  /** Only the future retained suffix; never the history being summarized. */
  retained: SessionEntry[];
};

export type PreparedCompactionPlanResult =
  | { status: "prepared"; plan: PreparedCompactionPlan }
  | { status: "skipped"; reason: string }
  | { status: "unsupported"; reason: string };
