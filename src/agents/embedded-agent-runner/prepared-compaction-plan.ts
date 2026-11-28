import {
  compactWithoutSummaryFromFacts,
  formatRequiredAskContext,
} from "../../../packages/agent-core/src/harness/compaction/compaction-assembly.js";
import { getMessageFromEntryForCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  collectCompactionFloorMessageFact,
  prepareCompactionFloorFromFacts,
  renderCompactionFloor,
} from "../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import { collectCompactionPreparationEntryFact } from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction-summary-budget.js";
import {
  collectConversationMessageFact,
  collectConversationRangeDescriptors,
  computeFileLists,
  extractCompactionMessageText,
  formatCompactionUserLabel,
  formatFileOperations,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import {
  iterateSessionContextEntryFacts,
  projectSessionContextMessage,
} from "../../../packages/agent-core/src/harness/session/session.js";
import { classifyToolPairingFacts } from "../../../packages/agent-core/src/harness/session/tool-pairing-facts.js";
import { copyString } from "../../../packages/agent-core/src/harness/utils/truncate.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { fitBackgroundResultDependencyFacts } from "../../config/sessions/session-background-result-dependencies.js";
import {
  buildPreservedTurnsSectionFromFacts,
  collectCompactionContextMessageFact,
  collectCompactionContextMessageIdentity,
  resolveRecentTurnsPreserve,
  selectPreservedRecentTurnIndexes,
} from "../agent-hooks/compaction-safeguard-context.js";
import {
  collectCompactionSafeguardAskFact,
  prepareCompactionSafeguardSummaryFacts,
  selectCompactionSafeguardAskIndex,
} from "../agent-hooks/compaction-safeguard-preparation.js";
import {
  extractOpaqueIdentifiers,
  extractOpaqueIdentifiersFromFacts,
  normalizeLegacySplitTurnSummary,
} from "../agent-hooks/compaction-safeguard-quality.js";
import {
  collectToolFailureFact,
  collectToolFailuresFromFacts,
  formatToolFailuresSection,
} from "../agent-hooks/compaction-safeguard-tool-failures.js";
import {
  isUnsummarizedCompactionMessage,
  sanitizeCompactionMessages,
} from "../compaction-planning.js";
import {
  collectRealConversationMessageFact,
  createRealConversationFactClassifier,
} from "../compaction-real-conversation.js";
import { projectAgentToolDefinition } from "../prepared-tool-definition.js";
import {
  createCompactionReplacementProjector,
  prepareAgentCompactionWorkFromFacts,
} from "../sessions/compaction/preparation.js";
import {
  estimateCompactedRequestTokens,
  replayTokenBudget,
} from "../sessions/compaction/request-budget.js";
import {
  collectMessageTokenPressureFact,
  createFixedRequestTokenEstimator,
} from "../sessions/context-token-pressure.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { collectExactReplaySourceFact } from "./exact-compaction-replay.js";
import type {
  PreparedCompactionEntryFact,
  PreparedCompactionMessageFact,
  PreparedCompactionMessageSource,
  PreparedCompactionPlanOptions,
  PreparedCompactionPlanResult,
} from "./prepared-compaction-plan.types.js";
import type { PreparedCompactionReplayOptions } from "./replay-history.types.js";
import { readModelSnapshotStateFromEntries } from "./replay-model-snapshot.js";
import {
  readToolSurfaceCheckpoint,
  selectToolSurfaceCheckpoint,
} from "./session-tool-checkpoint.js";

/** Only bounded excerpts, exact inventories, and scalar projections survive the decoded row. */
export function collectPreparedCompactionEntryFact(
  entry: SessionEntry,
  rawSeq: number,
  replay?: PreparedCompactionReplayOptions,
): PreparedCompactionEntryFact {
  const fact = collectCompactionPreparationEntryFact(entry, rawSeq);
  const message = getMessageFromEntryForCompaction(entry);
  const collect = (
    value: AgentMessage,
    source: PreparedCompactionMessageSource = rawSeq,
  ): PreparedCompactionMessageFact => ({
    source,
    role: value.role,
    unsummarized: isUnsummarizedCompactionMessage(value),
    real: collectRealConversationMessageFact(value),
    context: collectCompactionContextMessageIdentity(value),
    floor: collectCompactionFloorMessageFact(value),
    failure: collectToolFailureFact(value),
    ask: collectCompactionSafeguardAskFact(value),
    sourceAsk: value.role === "user" && Boolean(extractCompactionMessageText(value)),
    conversation: convertToLlm(sanitizeCompactionMessages([value])).map((projected) =>
      collectConversationMessageFact(projected, source),
    ),
  });
  const summary = message ? collect(message) : undefined;
  const project = (context: "current" | "retained" | "reset-retained") =>
    projectSessionContextMessage({
      entry,
      context,
      placement: fact.pendingBackground ? entry : undefined,
    });
  const current = project("current");
  const retained = project("retained");
  const reset = project("reset-retained");
  const contextSummaries: PreparedCompactionEntryFact["contextSummaries"] = {};
  const contextReplay: PreparedCompactionEntryFact["contextReplay"] = {};
  const projectedReplay = new Map<AgentMessage, NonNullable<typeof contextReplay.current>>();
  for (const [context, projected] of [
    ["current", current],
    ["retained", retained],
    ["reset-retained", reset],
  ] as const) {
    if (projected) {
      let replayFact = projectedReplay.get(projected);
      if (!replayFact) {
        replayFact = collectExactReplaySourceFact(
          projected,
          { seq: rawSeq, context, placed: fact.pendingBackground },
          replay,
        );
        projectedReplay.set(projected, replayFact);
      }
      contextReplay[context] = replayFact;
      contextSummaries[context] =
        projected === message
          ? summary
          : collect(projected, {
              seq: rawSeq,
              context,
              placed: fact.pendingBackground,
            });
    }
  }
  const snapshot = readModelSnapshotStateFromEntries([entry]).lastSnapshot;
  return {
    ...fact,
    parentId: entry.parentId,
    idempotencyKey:
      entry.type === "message" &&
      entry.message.role === "user" &&
      "idempotencyKey" in entry.message &&
      typeof entry.message.idempotencyKey === "string"
        ? copyString(entry.message.idempotencyKey)
        : undefined,
    summary,
    contextReplay,
    contextSummaries,
    markers: {
      ...(entry.type === "custom" && entry.customType === "google-turn-ordering-bootstrap"
        ? { googleTurnOrdering: true as const }
        : {}),
      ...(entry.type === "custom" && entry.customType === "openclaw.system-prompt"
        ? { toolCheckpoint: true as const }
        : {}),
      ...(entry.type === "thinking_level_change" ? { thinkingLevel: entry.thinkingLevel } : {}),
      ...(snapshot
        ? {
            modelSnapshot: {
              timestamp: snapshot.timestamp,
              provider: snapshot.provider,
              modelApi: snapshot.modelApi,
              modelId: snapshot.modelId,
            },
          }
        : {}),
    },
  };
}

/** Pure fact reduction; selected asks and kept-tail payloads never escape this synchronous call. */
export function prepareCompactionPlan(
  entries: readonly PreparedCompactionEntryFact[],
  options: PreparedCompactionPlanOptions,
  source: { readEntry: (rawSeq: number) => SessionEntry },
): PreparedCompactionPlanResult {
  const bySequence = new Map(entries.map((entry) => [entry.sourceIndex, entry]));
  const fixedTokenPressure = { ...createFixedRequestTokenEstimator()(options.work) };
  const toolMarker = selectToolSurfaceCheckpoint(entries, (entry) =>
    Boolean(entry.markers.toolCheckpoint),
  );
  if (toolMarker) {
    const tools = readToolSurfaceCheckpoint([source.readEntry(toolMarker.sourceIndex)])?.tools;
    if (tools) {
      fixedTokenPressure.toolTokens = createFixedRequestTokenEstimator()({
        tools: tools.map((tool) => projectAgentToolDefinition({ ...tool, label: tool.name })),
      }).toolTokens;
    }
  }
  const retainedSequences = (firstKeptEntryId: string) => {
    const first = entries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (first < 0) {
      throw new Error("Prepared compaction lost its retained boundary");
    }
    const candidates = entries.map((entry, seq) => {
      if (entry.placementResultIds === "invalid") {
        throw new Error("Invalid background result placement marker");
      }
      return {
        seq,
        serialized_bytes: 0,
        type: entry.type,
        id: entry.id,
        pending: entry.pendingBackground,
        placement: entry.placementResultIds,
      };
    });
    const selected = new Set(
      fitBackgroundResultDependencyFacts(candidates.slice(first), candidates, 0).rows.map(
        (row) => row.seq,
      ),
    );
    return entries.flatMap((entry, index) => (selected.has(index) ? [entry.sourceIndex] : []));
  };
  const replacement = (firstKeptEntryId: string, tokensBefore: number) =>
    createCompactionReplacementProjector(
      retainedSequences(firstKeptEntryId).map(source.readEntry),
      options.work.itemId,
    )({ firstKeptEntryId, tokensBefore }, "");
  const work = prepareAgentCompactionWorkFromFacts(
    entries,
    { ...options.work, fixedTokenPressure },
    (preparation, budget) =>
      estimateCompactedRequestTokens(
        replacement(preparation.firstKeptEntryId, preparation.tokensBefore),
        budget,
      ),
    (entry, context) => {
      const message = readPreparedCompactionMessage(
        context === "message"
          ? entry.sourceIndex
          : { seq: entry.sourceIndex, context, placed: entry.pendingBackground },
        source.readEntry,
      );
      return message ? collectMessageTokenPressureFact(message) : undefined;
    },
  );
  if (work.status === "skipped") {
    return work;
  }
  const { historyEntryIndexes, turnPrefixEntryIndexes, firstKeptEntryIndex, ...preparation } =
    work.preparation;
  const select = (sequences: readonly number[]) =>
    sequences.flatMap((seq) => {
      const message = bySequence.get(seq)?.summary;
      return message ? [message] : [];
    });
  const rawHistory = select(historyEntryIndexes);
  const rawPrefix = select(turnPrefixEntryIndexes);
  const floor = prepareCompactionFloorFromFacts(
    [...rawHistory, ...rawPrefix].map((message) => message.floor),
  );
  const summarized = (messages: PreparedCompactionMessageFact[]) =>
    messages.filter((message) => !message.unsummarized);
  const real = (messages: readonly PreparedCompactionMessageFact[]) => {
    const classify = createRealConversationFactClassifier();
    return messages.some((message) => classify(message.real));
  };
  const context = (path: readonly PreparedCompactionEntryFact[]) =>
    Array.from(iterateSessionContextEntryFacts(path)).flatMap(({ entry, context: projection }) => {
      const summary = entry.contextSummaries[projection];
      return summary ? [summary] : [];
    });
  let history = summarized(rawHistory);
  let prefix = summarized(rawPrefix);
  let hasRealConversation = real([...history, ...prefix]);
  let usedPreparationRange = false;
  if (!hasRealConversation) {
    const range = summarized(
      context(
        entries.filter(
          (entry, index) =>
            index < firstKeptEntryIndex || entry.type === "compaction" || entry.type === "reset",
        ),
      ).filter((message) => message.role !== "compactionSummary"),
    );
    if (real(range)) {
      history = range;
      prefix = [];
      hasRealConversation = true;
      usedPreparationRange = true;
    }
  }
  hasRealConversation ||= real(summarized(context(entries)));
  const previousSummary = normalizeLegacySplitTurnSummary(preparation.previousSummary?.trim());
  const oracle = [...history, ...prefix];
  const readMessage = (fact: PreparedCompactionMessageFact) => {
    const message = readPreparedCompactionMessage(fact.source, source.readEntry);
    if (!message) {
      throw new Error("Compaction selected message lost its source message");
    }
    return message;
  };
  const readAsk = (messages: PreparedCompactionMessageFact[]) => {
    const index = selectCompactionSafeguardAskIndex(messages.map((message) => message.ask));
    return index === null ? null : extractCompactionMessageText(readMessage(messages[index]!));
  };
  const preservedIndexes = selectPreservedRecentTurnIndexes(
    history.map((message) => message.context),
    resolveRecentTurnsPreserve(options.recentTurnsPreserve),
  );
  const preservedTurnsSection = buildPreservedTurnsSectionFromFacts(
    history
      .filter((_message, index) => preservedIndexes.has(index))
      .map((message) => collectCompactionContextMessageFact(readMessage(message))),
    Math.floor((preparation.settings.maxSummaryChars ?? MAX_COMPACTION_SUMMARY_CHARS) / 2),
  );
  const summarizable = history.filter((_message, index) => !preservedIndexes.has(index));
  // Repair affects only the count consumed by reconciliation, not its raw summary selection.
  let summarizableMessageCount = summarizable.length;
  if (
    resolveRecentTurnsPreserve(options.recentTurnsPreserve) > 0 &&
    history.some((message) => message.role === "user" || message.role === "assistant")
  ) {
    const frames = classifyToolPairingFacts(summarizable.map((message) => message.context.pairing));
    const selected = new Set<number>();
    let synthetic = 0;
    for (const [index, message] of summarizable.entries()) {
      if (message.role !== "toolResult") {
        selected.add(index);
      }
    }
    for (const frame of frames) {
      for (const occurrence of frame.occurrences) {
        if (occurrence.result) {
          selected.add(occurrence.result.index);
        } else if (!frame.failed) {
          synthetic++;
        }
      }
    }
    summarizableMessageCount = selected.size + synthetic;
  }
  const { reconcile, ...summary } = prepareCompactionSafeguardSummaryFacts({
    previousSummary,
    requestSelection: preparation.requestSelection,
    latestUnresolvedUserRequest: preparation.latestUnresolvedUserRequest,
    oracleAsk: preparation.requestSelection ? null : readAsk(oracle),
    splitUserAsk: preparation.isSplitTurn ? readAsk(prefix) : null,
    latestPreparedAsk: readAsk(history),
    preservedTurnsText: preservedTurnsSection.text,
    summarizableMessageCount,
    turnPrefixMessageCount: prefix.length,
    qualityGuardEnabled: options.qualityGuardEnabled,
  });
  const sourceAskFact = preparation.isSplitTurn
    ? rawPrefix.findLast((message) => message.sourceAsk)
    : undefined;
  const sourceAskMessage = sourceAskFact ? readMessage(sourceAskFact) : undefined;
  const sourceLabel = sourceAskMessage ? formatCompactionUserLabel(sourceAskMessage) : "User";
  const sourceText = sourceAskMessage ? extractCompactionMessageText(sourceAskMessage) : "";
  const deterministic = compactWithoutSummaryFromFacts(preparation, {
    droppedCount: rawHistory.length + rawPrefix.length,
    sourceAsk: sourceAskMessage
      ? formatRequiredAskContext(
          sourceLabel === "User" ? sourceText : `[${sourceLabel}]: ${sourceText}`,
        )
      : "",
    floor: renderCompactionFloor(floor),
  });
  const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
  const selectedHistory = options.safeguard === false ? rawHistory : reconcile ? oracle : [];
  const selectedPrefix = options.safeguard === false ? rawPrefix : prefix;
  const summaryReplayTokenBudget =
    preparation.summaryTokenBudget === undefined
      ? replayTokenBudget(
          { agent: { state: { fixedTokenPressure } } },
          { contextWindow: options.work.contextWindow },
          preparation.settings,
          options.work.contextWindow && options.work.contextWindow > 0
            ? replacement(preparation.firstKeptEntryId, preparation.tokensBefore)
            : [],
        )
      : undefined;
  return {
    status: "prepared",
    plan: {
      preparation,
      facts: {
        previousSummary,
        history: { hasRealConversation, usedPreparationRange },
        sections: {
          readFiles,
          modifiedFiles,
          fileOpsSummary: formatFileOperations(readFiles, modifiedFiles),
          toolFailureSection: formatToolFailuresSection(
            collectToolFailuresFromFacts(oracle.map((message) => message.failure)),
          ),
        },
        summary: {
          ...summary,
          identifiers: extractOpaqueIdentifiersFromFacts(
            oracle
              .slice(-10)
              .map((message) =>
                extractOpaqueIdentifiers(extractCompactionMessageText(readMessage(message))),
              ),
          ),
          preservedTurnsSection,
        },
        reconciliationCount: selectedHistory.length,
        turnPrefixCount: selectedPrefix.length,
      },
      floor,
      ...(deterministic.ok
        ? { deterministic: deterministic.value }
        : {
            deterministicError: {
              code: deterministic.error.code,
              message: deterministic.error.message,
            },
          }),
      pendingEntryId: work.pendingEntryId,
      requestBudget: work.requestBudget,
      requestTokenLimit: work.requestTokenLimit,
      selections: {
        history: collectConversationRangeDescriptors(
          selectedHistory.flatMap((message) => message.conversation),
        ),
        turnPrefix: collectConversationRangeDescriptors(
          selectedPrefix.flatMap((message) => message.conversation),
        ),
      },
      retainedSequences: retainedSequences(preparation.firstKeptEntryId),
      summaryReplayTokenBudget,
    },
  };
}

/** Reconstruct the same canonical projection used when its scalar descriptors were collected. */
export function readPreparedCompactionMessage(
  source: PreparedCompactionMessageSource,
  readEntry: (seq: number) => SessionEntry,
): AgentMessage | undefined {
  if (typeof source === "number") {
    return getMessageFromEntryForCompaction(readEntry(source));
  }
  const entry = readEntry(source.seq);
  return projectSessionContextMessage({
    entry,
    context: source.context,
    placement: source.placed ? entry : undefined,
  });
}
