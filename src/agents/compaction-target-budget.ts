import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  estimateTokens,
  findCutPoint,
  type FileOperations,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";

export const TARGET_BUDGET_MAX_ATTEMPTS = 4;
const MIN_KEEP_RECENT_TOKENS = 1;
const MIN_REDUCTION_RATIO = 0.2;

export type CompactionPreparationLike = {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
};

export type CompactionResultLike<TDetails = unknown> = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: TDetails;
};

export type TargetBudgetOutcome<TDetails = unknown> = {
  result: CompactionResultLike<TDetails>;
  preparation: CompactionPreparationLike;
  targetReached: boolean;
  estimatedFullTokensAfter: number;
  fixedOverheadTokens: number;
  usedHistoryOnlyFallback: boolean;
  warnings: string[];
};

function createFileOps(): FileOperations {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    if (typeof block !== "object" || block === null || block.type !== "toolCall") {
      continue;
    }
    const args = block.arguments;
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (!path) {
      continue;
    }
    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: new Date(entry.timestamp).getTime(),
    } as AgentMessage;
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: new Date(entry.timestamp).getTime(),
    } as AgentMessage;
  }
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    } as AgentMessage;
  }
  return undefined;
}

function findPreviousCompactionIndex(entries: SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      return index;
    }
  }
  return -1;
}

function extendFileOpsFromPreviousCompaction(
  fileOps: FileOperations,
  entry: SessionEntry | undefined,
): void {
  if (!entry || entry.type !== "compaction" || entry.fromHook === true || !entry.details) {
    return;
  }
  const details = entry.details as {
    readFiles?: unknown;
    modifiedFiles?: unknown;
  };
  if (Array.isArray(details.readFiles)) {
    for (const filePath of details.readFiles) {
      if (typeof filePath === "string") {
        fileOps.read.add(filePath);
      }
    }
  }
  if (Array.isArray(details.modifiedFiles)) {
    for (const filePath of details.modifiedFiles) {
      if (typeof filePath === "string") {
        fileOps.edited.add(filePath);
      }
    }
  }
}

function collectMessagesInRange(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const message = getMessageFromEntry(entries[index]);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function collectKeptMessages(entries: SessionEntry[], firstKeptEntryId: string): AgentMessage[] {
  const firstIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstIndex < 0) {
    return [];
  }
  return collectMessagesInRange(entries, firstIndex, entries.length);
}

function estimateCompactionSummaryTokens(summary: string): number {
  return Math.max(1, Math.ceil(summary.length / 4));
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function clampKeepRecentTokens(keepRecentTokens: number, tokensBefore: number): number {
  const normalizedKeepRecentTokens = Math.max(MIN_KEEP_RECENT_TOKENS, Math.floor(keepRecentTokens));
  const maxKeepRecentTokens = Math.max(MIN_KEEP_RECENT_TOKENS, Math.floor(tokensBefore) - 1);
  return Math.min(normalizedKeepRecentTokens, maxKeepRecentTokens);
}

export function rebuildCompactionPreparationForKeepRecentTokens(params: {
  branchEntries: SessionEntry[];
  basePreparation: CompactionPreparationLike;
  keepRecentTokens: number;
}): CompactionPreparationLike | undefined {
  const prevCompactionIndex = findPreviousCompactionIndex(params.branchEntries);
  const boundaryStart = prevCompactionIndex + 1;
  const boundaryEnd = params.branchEntries.length;
  const keepRecentTokens = clampKeepRecentTokens(
    params.keepRecentTokens,
    params.basePreparation.tokensBefore,
  );
  const cutPoint = findCutPoint(params.branchEntries, boundaryStart, boundaryEnd, keepRecentTokens);
  const firstKeptEntry = params.branchEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined;
  }
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize = collectMessagesInRange(
    params.branchEntries,
    boundaryStart,
    historyEnd,
  );
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? collectMessagesInRange(
        params.branchEntries,
        cutPoint.turnStartIndex,
        cutPoint.firstKeptEntryIndex,
      )
    : [];
  const fileOps = createFileOps();
  extendFileOpsFromPreviousCompaction(fileOps, params.branchEntries[prevCompactionIndex]);
  for (const message of [...messagesToSummarize, ...turnPrefixMessages]) {
    extractFileOpsFromMessage(message, fileOps);
  }
  const previousSummary =
    prevCompactionIndex >= 0 && params.branchEntries[prevCompactionIndex]?.type === "compaction"
      ? params.branchEntries[prevCompactionIndex].summary
      : params.basePreparation.previousSummary;
  return {
    ...params.basePreparation,
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    previousSummary,
    fileOps,
    settings: {
      ...params.basePreparation.settings,
      keepRecentTokens,
    },
  };
}

export function estimateFullContextTokensAfterCompaction(params: {
  branchEntries: SessionEntry[];
  result: CompactionResultLike;
  fixedOverheadTokens?: number;
}): number {
  const keptMessages = collectKeptMessages(params.branchEntries, params.result.firstKeptEntryId);
  return (
    Math.max(0, Math.floor(params.fixedOverheadTokens ?? 0)) +
    estimateCompactionSummaryTokens(params.result.summary) +
    estimateMessagesTokens(keptMessages)
  );
}

function reduceKeepRecentTokens(currentKeepRecentTokens: number, excessTokens: number): number {
  const ratioReduction = Math.max(1, Math.floor(currentKeepRecentTokens * MIN_REDUCTION_RATIO));
  const absoluteReduction = Math.max(1, Math.ceil(excessTokens));
  return Math.max(
    MIN_KEEP_RECENT_TOKENS,
    currentKeepRecentTokens - Math.max(ratioReduction, absoluteReduction),
  );
}

function resolveFixedOverheadTokens(params: {
  basePreparation: CompactionPreparationLike;
  liveContextTokens?: number | null;
}): {
  fixedOverheadTokens: number;
  usedHistoryOnlyFallback: boolean;
} {
  const liveContextTokens =
    typeof params.liveContextTokens === "number" && Number.isFinite(params.liveContextTokens)
      ? Math.max(0, Math.floor(params.liveContextTokens))
      : undefined;
  if (liveContextTokens === undefined) {
    return {
      fixedOverheadTokens: 0,
      usedHistoryOnlyFallback: true,
    };
  }
  return {
    fixedOverheadTokens: Math.max(
      0,
      liveContextTokens - Math.max(0, Math.floor(params.basePreparation.tokensBefore)),
    ),
    usedHistoryOnlyFallback: false,
  };
}

export async function runTargetBudgetCompaction<TDetails>(params: {
  branchEntries: SessionEntry[];
  basePreparation: CompactionPreparationLike;
  targetTokens: number;
  liveContextTokens?: number | null;
  execute: (preparation: CompactionPreparationLike) => Promise<CompactionResultLike<TDetails>>;
}): Promise<TargetBudgetOutcome<TDetails>> {
  const { fixedOverheadTokens, usedHistoryOnlyFallback } = resolveFixedOverheadTokens({
    basePreparation: params.basePreparation,
    liveContextTokens: params.liveContextTokens,
  });
  const warnings: string[] = [];
  if (usedHistoryOnlyFallback) {
    warnings.push(
      "Compaction targetTokens fell back to history-only budgeting because live context usage was unavailable.",
    );
  }
  if (fixedOverheadTokens >= params.targetTokens) {
    warnings.push(
      `Compaction targetTokens=${params.targetTokens} is below fixed overhead ${fixedOverheadTokens}; ` +
        "compacting as aggressively as possible.",
    );
  }

  let keepRecentTokens = clampKeepRecentTokens(
    Math.max(MIN_KEEP_RECENT_TOKENS, params.targetTokens - fixedOverheadTokens),
    params.basePreparation.tokensBefore,
  );
  let bestOutcome:
    | {
        preparation: CompactionPreparationLike;
        result: CompactionResultLike<TDetails>;
        estimatedFullTokensAfter: number;
      }
    | undefined;

  for (let attempt = 0; attempt < TARGET_BUDGET_MAX_ATTEMPTS; attempt += 1) {
    const preparation =
      rebuildCompactionPreparationForKeepRecentTokens({
        branchEntries: params.branchEntries,
        basePreparation: params.basePreparation,
        keepRecentTokens,
      }) ?? params.basePreparation;
    const result = await params.execute(preparation);
    const estimatedFullTokensAfter = estimateFullContextTokensAfterCompaction({
      branchEntries: params.branchEntries,
      result,
      fixedOverheadTokens,
    });
    if (!bestOutcome || estimatedFullTokensAfter < bestOutcome.estimatedFullTokensAfter) {
      bestOutcome = {
        preparation,
        result,
        estimatedFullTokensAfter,
      };
    }
    if (
      estimatedFullTokensAfter <= params.targetTokens ||
      keepRecentTokens <= MIN_KEEP_RECENT_TOKENS
    ) {
      return {
        ...bestOutcome,
        targetReached: estimatedFullTokensAfter <= params.targetTokens,
        fixedOverheadTokens,
        usedHistoryOnlyFallback,
        warnings,
      };
    }
    const nextKeepRecentTokens = reduceKeepRecentTokens(
      keepRecentTokens,
      estimatedFullTokensAfter - params.targetTokens,
    );
    if (nextKeepRecentTokens >= keepRecentTokens) {
      break;
    }
    keepRecentTokens = nextKeepRecentTokens;
  }

  if (!bestOutcome) {
    throw new Error("target-budget compaction produced no attempts");
  }
  warnings.push(
    `Compaction could not reach targetTokens=${params.targetTokens}; returning the smallest estimated context instead.`,
  );
  return {
    ...bestOutcome,
    targetReached: bestOutcome.estimatedFullTokensAfter <= params.targetTokens,
    fixedOverheadTokens,
    usedHistoryOnlyFallback,
    warnings,
  };
}
