/** Pure safeguard input policy shared by array hooks and worker-local preparation. */
import { formatRequiredAskContext } from "../../../packages/agent-core/src/harness/compaction/compaction-assembly.js";
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
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import {
  buildPreservedTurnsSection,
  buildSplitTurnContextSection,
  resolveRecentTurnsPreserve,
  splitPreservedRecentTurns,
} from "./compaction-safeguard-context.js";
import {
  extractOpaqueIdentifiers,
  extractOpaqueIdentifiersFromFacts,
  normalizeLegacySplitTurnSummary,
} from "./compaction-safeguard-quality.js";
import {
  collectToolFailures,
  formatToolFailuresSection,
} from "./compaction-safeguard-tool-failures.js";

export type CompactionSafeguardMessages = {
  previousSummary: string | undefined;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
};

export type CompactionSafeguardHistory = CompactionSafeguardMessages & {
  hasRealConversation: boolean;
  usedPreparationRange: boolean;
};

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
}) {
  const { readFiles, modifiedFiles } = computeFileLists(params.fileOps);
  const { messagesToSummarize, turnPrefixMessages } = params.history;
  return {
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
export function prepareCompactionSafeguardContext(params: {
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

/** Undefined is a non-user; false is an independent input that stops ask lookup. */
export function collectCompactionSafeguardAskFact(message: AgentMessage): boolean | undefined {
  return message.role === "user"
    ? extractCurrentCompactionUserRequest([message], () => "") !== null
    : undefined;
}

/** Return a selected-sequence locator; reread only that row for the exact, uncapped ask. */
export function selectCompactionSafeguardAskIndex(
  facts: readonly (boolean | undefined)[],
): number | null {
  for (let index = facts.length - 1; index >= 0; index--) {
    if (facts[index] !== undefined) {
      return facts[index] ? index : null;
    }
  }
  return null;
}

function readSelectedAsk(messages: AgentMessage[]): string | null {
  const index = selectCompactionSafeguardAskIndex(messages.map(collectCompactionSafeguardAskFact));
  return index === null ? null : extractMessageText(messages[index]!);
}

/** Final scalar policy shared by array preparation and a selected compaction view. */
export function prepareCompactionSafeguardSummaryFacts(params: {
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
}) {
  const { messagesToSummarize, turnPrefixMessages, previousSummary } = params.history;
  const { requestSelection, latestUnresolvedUserRequest } = params.preparation;
  const oracleMessages =
    turnPrefixMessages.length > 0
      ? [...messagesToSummarize, ...turnPrefixMessages]
      : messagesToSummarize;
  const identifiers = extractOpaqueIdentifiersFromFacts(
    oracleMessages
      .slice(-10)
      .map((message) => extractOpaqueIdentifiers(extractMessageText(message))),
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
    oracleAsk: requestSelection ? null : readSelectedAsk(oracleMessages),
    splitUserAsk: params.preparation.isSplitTurn ? readSelectedAsk(turnPrefixMessages) : null,
    latestPreparedAsk: readSelectedAsk(messagesToSummarize),
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
