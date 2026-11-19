import type {
  PreparedCompactionFloor,
  CompactionFloorMessageFact,
} from "../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import type {
  CompactionPreparation,
  compactWithoutSummary,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { ConversationEntryDescriptor } from "../../../packages/agent-core/src/harness/compaction/conversation-serialization.js";
import type { ConversationMessageFact } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { CompactionError } from "../../../packages/agent-core/src/harness/types.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { CompactionContextMessageFact } from "../agent-hooks/compaction-safeguard-context.js";
import type { PreparedCompactionSafeguardFacts } from "../agent-hooks/compaction-safeguard-prepared.types.js";
import type { ToolFailure } from "../agent-hooks/compaction-safeguard-tool-failures.js";
import type { RealConversationMessageFact } from "../compaction-real-conversation.js";
import type {
  AgentCompactionPreparationOptions,
  AgentCompactionPreparationEntryFact,
} from "../sessions/compaction/preparation.types.js";
import type { ExactReplaySourceFact } from "./exact-compaction-replay.js";
import type { ModelSnapshotEntry } from "./replay-model-snapshot.js";

export type PreparedCompactionMessageSource =
  | number
  | {
      seq: number;
      context: "current" | "retained" | "reset-retained";
      placed: boolean;
    };

export type PreparedCompactionMessageFact = {
  source: PreparedCompactionMessageSource;
  role: AgentMessage["role"];
  runtime: boolean;
  real: RealConversationMessageFact;
  context: Pick<CompactionContextMessageFact, "role" | "pairing">;
  floor: CompactionFloorMessageFact;
  failure?: ToolFailure;
  ask: boolean | undefined;
  sourceAsk: boolean;
  conversation: ConversationMessageFact<PreparedCompactionMessageSource>[];
};

export type PreparedCompactionEntryFact = AgentCompactionPreparationEntryFact & {
  parentId: string | null;
  summary?: PreparedCompactionMessageFact;
  contextReplay: Partial<
    Record<
      "current" | "retained" | "reset-retained",
      ExactReplaySourceFact<PreparedCompactionMessageSource>
    >
  >;
  contextSummaries: Partial<
    Record<"current" | "retained" | "reset-retained", PreparedCompactionMessageFact>
  >;
  markers: {
    toolCheckpoint?: true;
    thinkingLevel?: string;
    modelSnapshot?: ModelSnapshotEntry;
    googleTurnOrdering?: true;
  };
};

export type PreparedCompactionPlanOptions = {
  work: AgentCompactionPreparationOptions;
  recentTurnsPreserve?: number;
  qualityGuardEnabled: boolean;
  safeguard?: boolean;
};

/** Private builtin-only metadata; not an ExtensionRunner or public SDK preparation. */
export type PreparedCompactionPlan = {
  preparation: Omit<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages">;
  facts: PreparedCompactionSafeguardFacts;
  floor: PreparedCompactionFloor;
  pendingEntryId?: string;
  requestBudget?: AgentCompactionPreparationOptions["requestBudget"];
  requestTokenLimit?: number;
  summaryReplayTokenBudget?: number;
  selections: {
    history: ConversationEntryDescriptor<PreparedCompactionMessageSource>[];
    turnPrefix: ConversationEntryDescriptor<PreparedCompactionMessageSource>[];
  };
  /** Only the future retained suffix; never the history being summarized. */
  retainedSequences: number[];
} & (
  | {
      deterministic: Extract<ReturnType<typeof compactWithoutSummary>, { ok: true }>["value"];
      deterministicError?: never;
    }
  | {
      deterministic?: never;
      deterministicError: { code: CompactionError["code"]; message: string };
    }
);

export type PreparedCompactionPlanResult =
  | { status: "prepared"; plan: PreparedCompactionPlan }
  | { status: "skipped"; reason: string };
