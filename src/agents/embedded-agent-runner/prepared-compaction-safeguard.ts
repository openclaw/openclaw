import { isDeepStrictEqual } from "node:util";
import { getMessageFromEntryForCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import type { CompactionFactPreparation } from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { collectConversationRangeDescriptors } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { PreparedCompactionEntry } from "../../config/sessions/session-compaction-prepared.types.js";
import {
  prepareCompactionSafeguardHistory,
  prepareCompactionSafeguardMessages,
  prepareCompactionSafeguardSections,
  prepareCompactionSafeguardSummary,
} from "../agent-hooks/compaction-safeguard-preparation.js";
import type { PreparedCompactionSafeguardFacts } from "../agent-hooks/compaction-safeguard-prepared.types.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";

/** The existing safeguard policy runs worker-local; only facts and source locations escape. */
export function prepareWorkerCompactionSafeguard(
  entries: readonly PreparedCompactionEntry[],
  preparation: CompactionFactPreparation,
  readEntry: (sequence: number) => SessionEntry,
  options: { recentTurnsPreserve?: number; qualityGuardEnabled: boolean },
) {
  const rows = entries.map((entry) => ({ fact: entry, entry: readEntry(entry.sourceIndex) }));
  const messages = rows.map((row) => ({
    ...row,
    message: getMessageFromEntryForCompaction(row.entry),
  }));
  const bySequence = new Map(messages.map((row) => [row.fact.sourceIndex, row]));
  const selectMessages = (sequences: number[]) =>
    sequences.flatMap((sequence) => {
      const message = bySequence.get(sequence)?.message;
      return message ? [message] : [];
    });
  const fullPreparation = {
    ...preparation,
    messagesToSummarize: selectMessages(preparation.historyEntryIndexes),
    turnPrefixMessages: selectMessages(preparation.turnPrefixEntryIndexes),
  };
  const history = prepareCompactionSafeguardHistory({
    messages: prepareCompactionSafeguardMessages(fullPreparation),
    firstKeptEntryId: preparation.firstKeptEntryId,
    readBranch: () => rows.map((row) => row.entry),
  });
  const summary = prepareCompactionSafeguardSummary({
    history,
    preparation,
    ...options,
    splitTurnContextChars: Math.floor(
      (preparation.settings.maxSummaryChars ?? MAX_COMPACTION_SUMMARY_CHARS) / 2,
    ),
  });
  const select = (selected: AgentMessage[]) => {
    let cursor = 0;
    return collectConversationRangeDescriptors(
      selected.flatMap((message) => {
        while (cursor < messages.length) {
          const row = messages[cursor++]!;
          if (row.message === message || isDeepStrictEqual(row.message, message)) {
            return row.fact.conversation;
          }
        }
        throw new Error("Safeguard reconciliation message lost its transcript source");
      }),
    );
  };
  const facts: PreparedCompactionSafeguardFacts = {
    previousSummary: history.previousSummary,
    history: {
      hasRealConversation: history.hasRealConversation,
      usedPreparationRange: history.usedPreparationRange,
    },
    sections: prepareCompactionSafeguardSections({ fileOps: preparation.fileOps, history }),
    summary: {
      latestUserAsk: summary.latestUserAsk,
      latestAskInRetainedTurn: summary.latestAskInRetainedTurn,
      identifiers: summary.identifiers,
      requiredAskContext: summary.requiredAskContext,
      preservedTurnsSection: summary.preservedTurnsSection,
    },
    reconciliationCount: summary.reconciliationMessages.length,
    turnPrefixCount: history.turnPrefixMessages.length,
  };
  return {
    facts,
    selections: {
      history: select(summary.reconciliationMessages),
      turnPrefix: select(history.turnPrefixMessages),
    },
  };
}
