import {
  compactWithoutSummary,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionDetails,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { SummarizationConversationSource } from "../../../packages/agent-core/src/harness/compaction/summarization-completion.js";
import type { prepareCompactionSafeguardSource } from "../agent-hooks/compaction-safeguard-source.js";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";

export type PreparedCompactionFacts = {
  requestTokenLimit?: number;
  preparation: Omit<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages">;
  historyCount: number;
  turnPrefixCount: number;
  reconciliationCount: number;
  messageCount: number;
  estimatedTokens: number;
  hasRealConversation: boolean;
  safeguard: Omit<
    ReturnType<typeof prepareCompactionSafeguardSource>,
    "history" | "turnPrefix" | "reconciliation"
  >;
  fallback?: CompactionResult<CompactionDetails>;
  fallbackError?: string;
};
export type PreparedCompaction = PreparedCompactionFacts & {
  /** Release the snapshot before transcript persistence or post-compaction reads. */
  release(): Promise<void>;
  signal: AbortSignal;
  history: SummarizationConversationSource;
  turnPrefix: SummarizationConversationSource;
  reconciliation: SummarizationConversationSource;
};
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
