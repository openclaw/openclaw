import type {
  CompactionPreparation,
  CompactionResult,
  CompactionDetails,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { SummarizationConversationSource } from "../../../packages/agent-core/src/harness/compaction/summarization-completion.js";

export type ContextSection = {
  text: string;
  segmentStarts: number[];
  truncatedLoss?: "split-turn-head" | "preserved-turn-head";
};

export type PreparedCompactionFacts = {
  requestTokenLimit?: number;
  preparation: Omit<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages">;
  historyCount: number;
  turnPrefixCount: number;
  reconciliationCount: number;
  messageCount: number;
  estimatedTokens: number;
  hasRealConversation: boolean;
  safeguard: {
    hasRealConversation: boolean;
    usedRangeFallback: boolean;
    toolFailureSection: string;
    preservedTurnsSection: ContextSection;
    identifiers: string[];
    latestUserAsk: string | null;
    latestAskInRetainedTurn: boolean;
    requiredAskContext: string;
  };
  fallback?: CompactionResult<CompactionDetails>;
  fallbackError?: string;
};
export type PreparedCompaction = PreparedCompactionFacts & {
  history: SummarizationConversationSource;
  turnPrefix: SummarizationConversationSource;
  reconciliation: SummarizationConversationSource;
};
