/** Pure safeguard input policy shared by array hooks and worker-local preparation. */
import { formatRequiredAskContext } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { CompactionPreparation } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  computeFileLists,
  extractCurrentCompactionUserRequest,
  extractCompactionMessageText as extractMessageText,
  formatFileOperations,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import type { SessionTreeEntry } from "../../../packages/agent-core/src/harness/types.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../copilot-dynamic-headers.js";
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import {
  buildPreservedTurnsSection,
  buildSplitTurnContextSection,
  resolveRecentTurnsPreserve,
  splitPreservedRecentTurns,
} from "./compaction-safeguard-context.js";
import type {
  CompactionSafeguardSummary,
  PreparedCompactionSafeguardFacts,
} from "./compaction-safeguard-prepared.types.js";
import {
  extractOpaqueIdentifiers,
  nestRequiredSummaryHeadings,
} from "./compaction-safeguard-quality.js";
import {
  collectToolFailures,
  formatToolFailuresSection,
} from "./compaction-safeguard-tool-failures.js";

const SPLIT_TURN_SECTION_HEADING = "**Turn Context (split turn):**";

function normalizeLegacySplitTurnSummary(summary: string | undefined): string | undefined {
  const splitTurnStart = summary?.indexOf(SPLIT_TURN_SECTION_HEADING) ?? -1;
  if (!summary || splitTurnStart < 0) {
    return summary;
  }
  const splitTurnContentStart = splitTurnStart + SPLIT_TURN_SECTION_HEADING.length;
  // Shipped safeguard summaries nested a second complete summary after this owned boundary.
  // Demote its headings only in the next model input; the persisted old boundary stays untouched.
  return `${summary.slice(0, splitTurnContentStart)}${nestRequiredSummaryHeadings(summary.slice(splitTurnContentStart))}`;
}

export type CompactionSafeguardMessages = {
  previousSummary: string | undefined;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
};

export type CompactionSafeguardHistory = CompactionSafeguardMessages &
  PreparedCompactionSafeguardFacts["history"];

function containsRealConversation(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
}

function projectBranchEntries(entries: SessionTreeEntry[]): AgentMessage[] {
  return buildSessionContext(entries).messages;
}

/** Keeps message identity/metadata; this is not a byte-bounded transport payload. */
export function prepareCompactionSafeguardMessages(
  preparation: Pick<
    CompactionPreparation,
    "previousSummary" | "messagesToSummarize" | "turnPrefixMessages"
  >,
): CompactionSafeguardMessages {
  return {
    previousSummary: normalizeLegacySplitTurnSummary(preparation.previousSummary?.trim()),
    messagesToSummarize: stripRuntimeContextCustomMessages(preparation.messagesToSummarize),
    turnPrefixMessages: stripRuntimeContextCustomMessages(preparation.turnPrefixMessages ?? []),
  };
}

/** Branch access stays lazy and is shared by the two boundary checks. */
export function prepareCompactionSafeguardHistory(params: {
  messages: CompactionSafeguardMessages;
  firstKeptEntryId: string;
  readBranch: () => SessionTreeEntry[];
}): CompactionSafeguardHistory {
  const { previousSummary } = params.messages;
  let { messagesToSummarize, turnPrefixMessages } = params.messages;
  let entries: SessionTreeEntry[] | undefined;
  const readBranch = () => (entries ??= params.readBranch());
  let hasRealConversation = containsRealConversation(
    turnPrefixMessages.length > 0
      ? [...messagesToSummarize, ...turnPrefixMessages]
      : messagesToSummarize,
  );
  let usedPreparationRange = false;
  if (!hasRealConversation) {
    const branch = readBranch();
    const firstKeptIndex = branch.findIndex((entry) => entry.id === params.firstKeptEntryId);
    // Keep replay boundaries even when retained entries precede the physical
    // marker. The projector, not the preparation cut, owns visibility.
    const rangeMessages =
      firstKeptIndex < 0
        ? []
        : stripRuntimeContextCustomMessages(
            projectBranchEntries(
              branch.filter(
                (entry, index) =>
                  index < firstKeptIndex || entry.type === "compaction" || entry.type === "reset",
              ),
            ).filter((message) => message.role !== "compactionSummary"),
          );
    if (containsRealConversation(rangeMessages)) {
      messagesToSummarize = rangeMessages;
      turnPrefixMessages = [];
      hasRealConversation = true;
      usedPreparationRange = true;
    }
  }
  // Pure tool traffic is work if the current context anchors it. Project the
  // current boundary; the raw branch would revive earlier resets/compactions.
  hasRealConversation ||= containsRealConversation(
    stripRuntimeContextCustomMessages(projectBranchEntries(readBranch())),
  );
  return {
    previousSummary,
    messagesToSummarize,
    turnPrefixMessages,
    hasRealConversation,
    usedPreparationRange,
  };
}

export function prepareCompactionSafeguardSections(params: {
  fileOps: CompactionPreparation["fileOps"];
  history: CompactionSafeguardHistory;
}): PreparedCompactionSafeguardFacts["sections"] {
  const { readFiles, modifiedFiles } = computeFileLists(params.fileOps);
  const { messagesToSummarize, turnPrefixMessages } = params.history;
  return {
    copilotHeaders: buildCopilotDynamicHeaders({
      messages: messagesToSummarize,
      hasImages: hasCopilotVisionInput(messagesToSummarize),
    }),
    readFiles,
    modifiedFiles,
    fileOpsSummary: formatFileOperations(readFiles, modifiedFiles),
    toolFailureSection: formatToolFailuresSection(
      collectToolFailures(
        turnPrefixMessages.length > 0
          ? [...messagesToSummarize, ...turnPrefixMessages]
          : messagesToSummarize,
      ),
    ),
  };
}

/** Kept separate so a custom provider still runs before any recent-turn splitting. */
function prepareCompactionSafeguardContext(params: {
  messagesToSummarize: AgentMessage[];
  recentTurnsPreserve?: number;
  splitTurnContextChars: number;
  turnPrefixMessages?: AgentMessage[];
}) {
  const { summarizableMessages, preservedMessages } = splitPreservedRecentTurns({
    messages: params.messagesToSummarize,
    recentTurnsPreserve: resolveRecentTurnsPreserve(params.recentTurnsPreserve),
  });
  return {
    summarizableMessages,
    preservedMessages,
    preservedTurnsSection: buildPreservedTurnsSection(
      preservedMessages,
      params.splitTurnContextChars,
    ),
    splitTurnSection: params.turnPrefixMessages
      ? buildSplitTurnContextSection(params.turnPrefixMessages, params.splitTurnContextChars)
      : undefined,
  };
}

/** Final scalar policy shared by array preparation and a selected compaction view. */
function prepareCompactionSafeguardSummaryFacts(params: {
  previousSummary: string | undefined;
  requestSelection: CompactionPreparation["requestSelection"];
  latestUnresolvedUserRequest: string | undefined;
  oracleAsk: string | null;
  splitUserAsk: string | null;
  latestPreparedAsk: string | null;
  preservedTurnsText: string;
  summarizableMessageCount: number;
  turnPrefixMessageCount: number;
  qualityGuardEnabled: boolean;
}) {
  const latestUserAsk = params.requestSelection
    ? params.requestSelection.state === "unresolved"
      ? params.requestSelection.request
      : null
    : params.oracleAsk;
  const latestAskInRetainedTurn =
    params.splitUserAsk !== null && params.splitUserAsk === latestUserAsk;
  const requiredAskContext = formatRequiredAskContext(latestUserAsk ?? "");
  const includePreservedContext =
    !params.latestUnresolvedUserRequest &&
    params.qualityGuardEnabled &&
    params.latestPreparedAsk === latestUserAsk &&
    !params.preservedTurnsText.includes(requiredAskContext);
  return {
    latestUserAsk,
    latestAskInRetainedTurn,
    requiredAskContext,
    reconcile: Boolean(
      params.previousSummary ||
      includePreservedContext ||
      params.summarizableMessageCount > 0 ||
      params.turnPrefixMessageCount > 0,
    ),
  };
}

/** Built-in reconciliation policy, evaluated after provider fallback and auth in the hook. */
export function prepareCompactionSafeguardSummary(params: {
  history: CompactionSafeguardHistory;
  preparation: Pick<
    CompactionPreparation,
    "isSplitTurn" | "requestSelection" | "latestUnresolvedUserRequest"
  >;
  recentTurnsPreserve?: number;
  splitTurnContextChars: number;
  qualityGuardEnabled: boolean;
}): CompactionSafeguardSummary {
  const { messagesToSummarize, turnPrefixMessages, previousSummary } = params.history;
  const { requestSelection, latestUnresolvedUserRequest } = params.preparation;
  const oracleMessages =
    turnPrefixMessages.length > 0
      ? [...messagesToSummarize, ...turnPrefixMessages]
      : messagesToSummarize;
  const identifiers = extractOpaqueIdentifiers(
    oracleMessages.slice(-10).map(extractMessageText).filter(Boolean).join("\n"),
  );
  const context = prepareCompactionSafeguardContext({
    messagesToSummarize,
    recentTurnsPreserve: params.recentTurnsPreserve,
    splitTurnContextChars: params.splitTurnContextChars,
  });
  const { reconcile, ...summaryFacts } = prepareCompactionSafeguardSummaryFacts({
    previousSummary,
    requestSelection,
    latestUnresolvedUserRequest,
    oracleAsk: requestSelection
      ? null
      : extractCurrentCompactionUserRequest(oracleMessages, extractMessageText),
    splitUserAsk: params.preparation.isSplitTurn
      ? extractCurrentCompactionUserRequest(turnPrefixMessages, extractMessageText)
      : null,
    latestPreparedAsk: extractCurrentCompactionUserRequest(messagesToSummarize, extractMessageText),
    preservedTurnsText: context.preservedTurnsSection.text,
    summarizableMessageCount: context.summarizableMessages.length,
    turnPrefixMessageCount: turnPrefixMessages.length,
    qualityGuardEnabled: params.qualityGuardEnabled,
  });
  // Retained excerpts cannot update an older decision by themselves.
  const reconciliationMessages = reconcile ? oracleMessages : [];
  return {
    ...context,
    turnPrefixMessages,
    oracleMessages,
    reconciliationMessages,
    ...summaryFacts,
    identifiers,
  };
}
