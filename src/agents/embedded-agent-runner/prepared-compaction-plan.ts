import { getMessageFromEntryForCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { prepareCompactionFloor } from "../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import {
  compactWithoutSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  MAX_SUMMARY_INPUT_CHARS,
  serializeConversationWithinBudget,
  type BoundedConversation,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { fitBackgroundResultDependencies } from "../../config/sessions/session-background-result-dependencies.js";
import {
  prepareCompactionSafeguardHistory,
  prepareCompactionSafeguardMessages,
  prepareCompactionSafeguardSections,
  prepareCompactionSafeguardSummary,
} from "../agent-hooks/compaction-safeguard-preparation.js";
import { sanitizeCompactionMessages } from "../compaction-planning.js";
import { projectAgentToolDefinition } from "../prepared-tool-definition.js";
import { prepareAgentCompactionWork } from "../sessions/compaction/preparation.js";
import { replayTokenBudget } from "../sessions/compaction/request-budget.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import type {
  PreparedCompactionPlanOptions,
  PreparedCompactionPlanResult,
} from "./prepared-compaction-plan.types.js";
import { readToolSurfaceCheckpoint } from "./session-tool-checkpoint.js";

/**
 * One decoded array serves every preparation consumer. The canonical preparation
 * reports each projection's source while creating it, so identical custom text
 * never requires guessing a row from content or timestamps.
 */
export function prepareCompactionPlan(
  entries: SessionEntry[],
  rowSequence: ReadonlyMap<string, number>,
  options: PreparedCompactionPlanOptions,
): PreparedCompactionPlanResult {
  const tools =
    readToolSurfaceCheckpoint(entries)?.tools.map((tool) =>
      projectAgentToolDefinition({ ...tool, label: tool.name }),
    ) ?? options.work.tools;
  const sequences = new Map<AgentMessage, number>();
  const work = prepareAgentCompactionWork(entries, { ...options.work, tools }, (entry, message) => {
    const seq = rowSequence.get(entry.id);
    if (seq !== undefined) {
      sequences.set(message, seq);
    }
  });
  if (work.status === "skipped") {
    return work;
  }
  const { preparation } = work;
  const history = prepareCompactionSafeguardHistory({
    messages: prepareCompactionSafeguardMessages(preparation),
    firstKeptEntryId: preparation.firstKeptEntryId,
    readBranch: () => entries,
  });
  const sections = prepareCompactionSafeguardSections({ fileOps: preparation.fileOps, history });
  const summary = prepareCompactionSafeguardSummary({
    history,
    preparation,
    recentTurnsPreserve: options.recentTurnsPreserve,
    splitTurnContextChars: Math.floor(
      (preparation.settings.maxSummaryChars ?? MAX_COMPACTION_SUMMARY_CHARS) / 2,
    ),
    qualityGuardEnabled: options.qualityGuardEnabled,
  });
  const select = (messages: AgentMessage[]) => {
    const selected: number[] = [];
    for (const message of messages) {
      const seq = sequences.get(message);
      if (seq === undefined) {
        return undefined;
      }
      selected.push(seq);
    }
    return selected;
  };
  const selectedHistory = select(summary.reconciliationMessages);
  const selectedTurnPrefix = select(summary.turnPrefixMessages);
  if (!selectedHistory || !selectedTurnPrefix) {
    return { status: "unsupported", reason: "summary source requires projected-entry provenance" };
  }
  const deterministic = compactWithoutSummary(preparation);
  if (!deterministic.ok) {
    // The normal path retains its own error and summary/floor recovery ordering.
    return {
      status: "unsupported",
      reason: "deterministic fallback requires the full preparation",
    };
  }
  const { messagesToSummarize, turnPrefixMessages, ...metadata } = preparation;
  const firstKeptIndex = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
  if (firstKeptIndex < 0) {
    throw new Error("Prepared compaction lost its retained boundary");
  }
  const candidates = entries.map((event, seq) => ({ seq, event, serialized_bytes: 0 }));
  const selected = new Set(
    fitBackgroundResultDependencies(candidates.slice(firstKeptIndex), candidates, 0).rows.map(
      (row) => row.seq,
    ),
  );
  // Session construction must not append initial metadata solely because the cut
  // omitted its recorded model or thinking marker. Other dropped payloads stay out.
  for (const type of ["thinking_level_change", "model_change"] as const) {
    const index = entries.findLastIndex((entry) => entry.type === type);
    if (index >= 0) {
      selected.add(index);
    }
  }
  const retained = entries.filter((_entry, index) => selected.has(index));
  // Match the commit owner: a foreground budget makes its replay fallback unused.
  const summaryReplayTokenBudget =
    preparation.summaryTokenBudget === undefined
      ? replayTokenBudget(
          { agent: { state: { systemPrompt: options.work.systemPrompt, tools } } },
          { contextWindow: options.work.contextWindow },
          preparation.settings,
          work.projectReplacement(preparation, ""),
        )
      : undefined;
  const plan = {
    preparation: metadata,
    facts: {
      previousSummary: history.previousSummary,
      history: {
        hasRealConversation: history.hasRealConversation,
        usedPreparationRange: history.usedPreparationRange,
      },
      sections,
      summary: {
        latestUserAsk: summary.latestUserAsk,
        latestAskInRetainedTurn: summary.latestAskInRetainedTurn,
        identifiers: summary.identifiers,
        requiredAskContext: summary.requiredAskContext,
        preservedTurnsSection: summary.preservedTurnsSection,
      },
      reconciliationCount: summary.reconciliationMessages.length,
      turnPrefixCount: summary.turnPrefixMessages.length,
    },
    floor: prepareCompactionFloor([...messagesToSummarize, ...turnPrefixMessages]),
    deterministic: deterministic.value,
    pendingEntryId: work.pendingEntryId,
    requestBudget: work.requestBudget,
    requestTokenLimit: work.requestTokenLimit,
    selections: { history: selectedHistory, turnPrefix: selectedTurnPrefix },
    retained,
    summaryReplayTokenBudget,
  };
  // Derived facts retain the summary-input bound. The selected retained context
  // keeps its existing full-fidelity hydration channel; metadata is not summary
  // input. Row-number vectors likewise describe source selection, not input text.
  const replyChars = JSON.stringify(
    { ...plan, selections: undefined, retained: undefined },
    (_key, value: unknown) => (value instanceof Set ? [...value] : value),
  ).length;
  if (replyChars > MAX_SUMMARY_INPUT_CHARS) {
    return { status: "unsupported", reason: "prepared compaction facts exceed the bounded reply" };
  }
  return { status: "prepared", plan };
}

/** Render each actual budget from captured full-fidelity rows, not a prior sample. */
export function renderPreparedCompactionRows(
  entries: readonly SessionEntry[],
  maxChars: number,
): BoundedConversation {
  const messages: AgentMessage[] = [];
  for (const entry of entries) {
    const message = getMessageFromEntryForCompaction(entry);
    if (!message) {
      throw new Error("Prepared compaction rendering requires original visible message rows");
    }
    messages.push(message);
  }
  return serializeConversationWithinBudget(
    convertToLlm(sanitizeCompactionMessages(messages)),
    maxChars,
  );
}
