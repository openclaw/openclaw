import { getMessageFromEntryForCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  estimateContextTokens,
  prepareCompactionEntryFacts,
} from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import type { CompactionResult } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { compactWithoutSummary } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { collectConversationRangeDescriptors } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import {
  buildSessionContext,
  iterateSessionContextEntryFacts,
  projectSessionContextMessage,
} from "../../../packages/agent-core/src/harness/session/session.js";
import type { PreparedCompactionEntry } from "../../config/sessions/session-compaction-prepared.types.js";
import { createRealConversationClassifier } from "../compaction-real-conversation.js";
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import {
  assertCompactionRequestCanFit,
  estimateCompactedRequestTokens,
  resolveCompactionRetentionBudget,
} from "../sessions/compaction/request-budget.js";
import {
  SAFETY_MARGIN,
  estimateCompactionHistoryTokens,
} from "../sessions/context-token-pressure.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import type {
  PreparedCompactionPlan,
  PreparedCompactionPlanOptions,
} from "./prepared-compaction-plan.types.js";
import { prepareWorkerCompactionSafeguard } from "./prepared-compaction-safeguard.js";

/** Payloads reconstructed here are worker-local and discarded before returning the plan. */
export function prepareCompactionPlan(
  entries: readonly PreparedCompactionEntry[],
  options: PreparedCompactionPlanOptions,
  readEntry: (seq: number) => SessionEntry,
) {
  const budget = options.requestBudget;
  const pendingKey = budget?.pendingTokens ? budget.pendingUserIdempotencyKey : undefined;
  const pendingIndex =
    options.pendingUserEntryId || pendingKey
      ? entries.findLastIndex(
          (entry) =>
            entry.role === "user" &&
            (options.pendingUserEntryId
              ? entry.id === options.pendingUserEntryId
              : entry.idempotencyKey === pendingKey),
        )
      : -1;
  if (options.pendingUserEntryId && pendingIndex < 0) {
    throw new Error("Compaction cannot find the admitted pending user request.");
  }
  const context = Array.from(iterateSessionContextEntryFacts(entries)).flatMap(
    ({ entry, context: projection }) => {
      const message = projectSessionContextMessage({
        entry: readEntry(entry.sourceIndex),
        context: projection,
      });
      return message ? [message] : [];
    },
  );
  assertCompactionRequestCanFit(context, budget, true);
  const retention = budget
    ? resolveCompactionRetentionBudget(budget, context, options.settings.maxSummaryChars)
    : undefined;
  const boundaryId = options.requestFromEntryId ?? entries[pendingIndex]?.id;
  const constraints =
    budget || boundaryId
      ? {
          ...(boundaryId
            ? {
                requestBoundary: {
                  entryId: boundaryId,
                  preserve: entries[pendingIndex]?.id === boundaryId,
                },
              }
            : {}),
          ...(retention ? { budget: retention } : {}),
        }
      : undefined;
  const estimate = (entry: PreparedCompactionEntry) => {
    const message = getMessageFromEntryForCompaction(readEntry(entry.sourceIndex));
    return message ? estimateCompactionHistoryTokens([message], budget) : 0;
  };
  const state = pendingKey && pendingIndex < 0 ? undefined : options.requestState;
  let prepared = prepareCompactionEntryFacts(
    entries,
    options.settings,
    state,
    constraints,
    estimate,
  );
  if (prepared.ok && !prepared.value && options.mode === "manual" && !state && pendingIndex < 0) {
    prepared = prepareCompactionEntryFacts(
      entries,
      { ...options.settings, keepRecentTokens: 0 },
      state,
      constraints,
      estimate,
    );
  }
  if (!prepared.ok) {
    throw prepared.error;
  }
  const messages = sanitizeCompactionReplayMessages(context);
  const classify = createRealConversationClassifier();
  const beforeHookMetrics = {
    messageCountOriginal: messages.length,
    tokenCountOriginal: estimateCompactionHistoryTokens(messages),
    messageCountBefore: messages.length,
    tokenCountBefore: estimateCompactionHistoryTokens(messages),
  };
  const hasRealConversation = messages.some(classify);
  if (!prepared.value) {
    assertCompactionRequestCanFit(context, budget, false);
    return { status: "skipped" as const, beforeHookMetrics, hasRealConversation };
  }
  const preparation = prepared.value;
  const retainedSequences = entries
    .slice(preparation.firstKeptEntryIndex)
    .map((entry) => entry.sourceIndex);
  const requestTokenLimit =
    budget && retention
      ? budget.fixedTokens + budget.pendingTokens + retention.maxTokens
      : undefined;
  if (budget && requestTokenLimit !== undefined) {
    const replacement = projectPreparedCompactionReplacement(
      retainedSequences.map(readEntry),
      preparation,
      "prepared-compaction",
      "",
    );
    preparation.summaryTokenBudget =
      Math.floor(
        (requestTokenLimit - estimateCompactedRequestTokens(replacement, budget)) / SAFETY_MARGIN,
      ) - 1;
  }
  const bySequence = new Map(entries.map((entry) => [entry.sourceIndex, entry]));
  const select = (sequences: number[]) =>
    collectConversationRangeDescriptors(
      sequences.flatMap((seq) => bySequence.get(seq)?.conversation ?? []),
    );
  const readMessages = (sequences: number[]) =>
    sequences.flatMap((seq) => {
      const message = getMessageFromEntryForCompaction(readEntry(seq));
      return message ? [message] : [];
    });
  const deterministic = compactWithoutSummary({
    ...preparation,
    messagesToSummarize: readMessages(preparation.historyEntryIndexes),
    turnPrefixMessages: readMessages(preparation.turnPrefixEntryIndexes),
  });
  const safeguard = options.safeguard
    ? prepareWorkerCompactionSafeguard(entries, preparation, readEntry, options.safeguard)
    : undefined;
  const plan: PreparedCompactionPlan = {
    preparation,
    selections: {
      history: select(preparation.historyEntryIndexes),
      turnPrefix: select(preparation.turnPrefixEntryIndexes),
    },
    ...(safeguard ? { safeguard: safeguard.facts, selections: safeguard.selections } : {}),
    retainedSequences,
    pendingEntryId: entries[pendingIndex]?.id,
    requestBudget: budget,
    requestTokenLimit,
    ...(deterministic.ok
      ? { deterministic: deterministic.value }
      : {
          deterministicError: {
            code: deterministic.error.code,
            message: deterministic.error.message,
          },
        }),
  };
  return { status: "prepared" as const, plan, beforeHookMetrics, hasRealConversation };
}

/** Use the canonical context projector for reset, retained tools, and prompt retirement. */
function projectPreparedCompactionReplacement(
  retained: SessionEntry[],
  result: Pick<CompactionResult, "firstKeptEntryId" | "tokensBefore">,
  itemId: string,
  summary: string,
) {
  return buildSessionContext([
    ...retained,
    {
      ...result,
      type: "compaction",
      id: itemId,
      parentId: retained.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      summary,
    },
  ]).messages;
}

/** Final checks run on selected rows inside the same validated read snapshot. */
export function finalizePreparedCompaction(
  retained: SessionEntry[],
  summary: CompactionResult,
  work: Pick<PreparedCompactionPlan, "requestBudget" | "requestTokenLimit" | "pendingEntryId"> & {
    itemId: string;
  },
  reportingBudget?: PreparedCompactionPlan["requestBudget"],
) {
  const first = retained.findIndex((entry) => entry.id === summary.firstKeptEntryId);
  if (first < 0) {
    throw new Error("Compaction retained boundary is not in the prepared source.");
  }
  if (
    work.pendingEntryId !== undefined &&
    first > retained.findIndex((entry) => entry.id === work.pendingEntryId)
  ) {
    throw new Error("Compaction must retain the unprocessed pending user request.");
  }
  const replacement = projectPreparedCompactionReplacement(
    retained,
    summary,
    work.itemId,
    summary.summary,
  );
  const budget = work.requestBudget;
  if (
    budget &&
    work.requestTokenLimit !== undefined &&
    estimateCompactedRequestTokens(replacement, budget) > work.requestTokenLimit
  ) {
    throw new Error(
      "The finalized compaction exceeds the foreground request budget. Reduce the request or select a larger context window.",
    );
  }
  const messages = sanitizeCompactionReplayMessages(replacement);
  return {
    tokensAfter: budget
      ? estimateCompactedRequestTokens(messages, { ...budget, pendingTokens: 0 })
      : estimateContextTokens(messages).tokens,
    reportingTokensAfter: reportingBudget
      ? estimateCompactedRequestTokens(messages, { ...reportingBudget, pendingTokens: 0 })
      : estimateCompactionHistoryTokens(messages),
    messageCountAfter: messages.length,
  };
}
