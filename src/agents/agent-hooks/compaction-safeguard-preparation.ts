/** Pure safeguard input policy shared by array hooks and worker-local preparation. */
import {
  formatRequiredAskContext,
  type CompactionPreparation,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
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
  const splitUserAsk = params.preparation.isSplitTurn
    ? extractCurrentCompactionUserRequest(turnPrefixMessages, extractMessageText)
    : null;
  const latestUserAsk = requestSelection
    ? requestSelection.state === "unresolved"
      ? requestSelection.request
      : null
    : extractCurrentCompactionUserRequest(oracleMessages, extractMessageText);
  const latestAskInRetainedTurn = splitUserAsk !== null && splitUserAsk === latestUserAsk;
  const identifiers = extractOpaqueIdentifiers(
    oracleMessages.slice(-10).map(extractMessageText).filter(Boolean).join("\n"),
  );
  const context = prepareCompactionSafeguardContext({
    messagesToSummarize,
    recentTurnsPreserve: params.recentTurnsPreserve,
    splitTurnContextChars: params.splitTurnContextChars,
  });
  const latestPreparedAsk = extractCurrentCompactionUserRequest(
    messagesToSummarize,
    extractMessageText,
  );
  const requiredAskContext = formatRequiredAskContext(latestUserAsk ?? "");
  const includePreservedContext =
    !latestUnresolvedUserRequest &&
    params.qualityGuardEnabled &&
    latestPreparedAsk === latestUserAsk &&
    !context.preservedTurnsSection.text.includes(requiredAskContext);
  // Retained excerpts cannot update an older decision by themselves. Reconcile
  // the complete window when there is earlier or non-preserved work to update.
  const reconciliationMessages =
    previousSummary ||
    includePreservedContext ||
    context.summarizableMessages.length > 0 ||
    turnPrefixMessages.length > 0
      ? oracleMessages
      : [];
  return {
    ...context,
    turnPrefixMessages,
    oracleMessages,
    reconciliationMessages,
    latestUserAsk,
    latestAskInRetainedTurn,
    identifiers,
    requiredAskContext,
  };
}
