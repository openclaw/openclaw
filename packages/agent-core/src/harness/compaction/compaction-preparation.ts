import type { Usage } from "@openclaw/llm-core";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { buildSessionContext } from "../session/session.js";
import { selectResetKeptEntries } from "../session/tool-result-pairing.js";
import { CompactionError, err, ok, type Result, type SessionTreeEntry } from "../types.js";
import {
  estimateTokens,
  findCutPoint,
  getMessageFromEntryForCompaction,
  type CompactionRetentionConstraints,
} from "./compaction-cut-point.js";
import {
  type CompactionDetails,
  MAX_LATEST_USER_REQUEST_CHARS,
  parseCompactionDetails,
} from "./compaction-details.js";
import { stripSummaryFloor } from "./compaction-floor.js";
import type {
  CompactionPreparation,
  CompactionSettings,
  ContextUsageEstimate,
} from "./compaction.js";
import {
  createFileOps,
  extractCompactionMessageText,
  extractFileOpsFromMessages,
  findLatestCompactionUserMessage,
  mergeSummaryFileOperations,
} from "./utils.js";

const LATEST_USER_REQUEST_TRUNCATED_MARKER = "\n[... latest user request truncated ...]\n";

function extractLatestUserRequest(messages: AgentMessage[]): string | undefined {
  const message = findLatestCompactionUserMessage(messages, extractCompactionMessageText);
  const source = message ? extractCompactionMessageText(message) : "";
  if (!source || source.length <= MAX_LATEST_USER_REQUEST_CHARS) {
    return source || undefined;
  }
  const contentBudget = MAX_LATEST_USER_REQUEST_CHARS - LATEST_USER_REQUEST_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  return `${truncateUtf16Safe(source, headBudget)}${LATEST_USER_REQUEST_TRUNCATED_MARKER}${sliceUtf16Safe(source, -(contentBudget - headBudget))}`;
}

export function calculateContextTokens(usage: Usage): number {
  if (usage.contextUsage?.state === "available") {
    return usage.contextUsage.totalTokens;
  }
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  return msg.role === "assistant" &&
    "usage" in msg &&
    msg.stopReason !== "aborted" &&
    msg.stopReason !== "error" &&
    msg.usage &&
    calculateContextTokens(msg.usage) > 0
    ? msg.usage
    : undefined;
}

function isUnavailableContextBarrier(message: AgentMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const usage = "usage" in message ? message.usage : undefined;
  if (!usage) {
    return false;
  }
  return (
    (message.api === "cli" && usage.contextUsage === undefined) ||
    (usage.contextUsage?.state === "unavailable" && calculateContextTokens(usage) === 0)
  );
}

export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type === "message") {
      if (isUnavailableContextBarrier(entry.message)) {
        return undefined;
      }
      const usage = getAssistantUsage(entry.message);
      if (usage) {
        return usage;
      }
    }
  }
  return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  let usageTokens = 0;
  let lastUsageIndex: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages.at(i);
    if (!message) {
      continue;
    }
    if (isUnavailableContextBarrier(message)) {
      // Synthetic CLI markers invalidate older usage without contributing a
      // replacement. Estimate the whole transcript instead of scanning past it.
      break;
    }
    const usage = getAssistantUsage(message);
    if (usage && usage.contextUsage?.state !== "unavailable") {
      usageTokens = calculateContextTokens(usage);
      lastUsageIndex = i;
      break;
    }
  }
  let trailingTokens = 0;
  for (const message of lastUsageIndex === null ? messages : messages.slice(lastUsageIndex + 1)) {
    trailingTokens += estimateTokens(message);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
}

/** Internal source fact for worker rendering; never sent to extension or model inputs. */
export type CompactionMessageProjection = (entry: SessionTreeEntry, message: AgentMessage) => void;

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompactionEntries(
  pathEntries: SessionTreeEntry[],
  settings: CompactionSettings,
  requestState?: "unresolved",
  constraints?: CompactionRetentionConstraints,
  onMessageProjection?: CompactionMessageProjection,
): Result<CompactionPreparation | undefined, CompactionError> {
  const lastEntry = pathEntries.at(-1);
  if (
    !lastEntry ||
    lastEntry.type === "reset" ||
    (lastEntry.type === "compaction" && lastEntry.fromHook)
  ) {
    // Safeguard-owned compactions are anti-loop boundaries for the current turn.
    return ok(undefined);
  }

  const prevBoundaryIndex = pathEntries.findLastIndex(
    (entry) => entry?.type === "compaction" || entry?.type === "reset",
  );

  let previousSummary: string | undefined;
  let previousSummaryDetails: CompactionDetails | undefined;
  let previousLatestUnresolvedUserRequest: string | undefined;
  let effectiveEntries = pathEntries;
  let resetPreludeMessages: AgentMessage[] = [];
  let boundaryStart = 0;
  if (prevBoundaryIndex >= 0) {
    const prevBoundary = pathEntries[prevBoundaryIndex];
    previousSummary =
      prevBoundary?.type === "compaction" ? stripSummaryFloor(prevBoundary.summary) : undefined;
    if (prevBoundary?.type === "compaction") {
      const details = parseCompactionDetails(prevBoundary.details);
      previousLatestUnresolvedUserRequest = details?.latestUnresolvedUserRequest;
      if (!prevBoundary.fromHook) {
        previousSummaryDetails = details;
      }
    }
    const firstKeptEntryId =
      prevBoundary?.type === "compaction" || prevBoundary?.type === "reset"
        ? prevBoundary.firstKeptEntryId
        : undefined;
    const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (prevBoundary?.type === "reset") {
      const keptEntries =
        firstKeptEntryIndex >= 0
          ? selectResetKeptEntries(pathEntries.slice(firstKeptEntryIndex, prevBoundaryIndex))
          : [];
      resetPreludeMessages = keptEntries.flatMap((entry) => {
        const message = getMessageFromEntryForCompaction(entry);
        if (message) {
          onMessageProjection?.(entry, message);
        }
        return message ? [message] : [];
      });
      effectiveEntries = pathEntries.slice(prevBoundaryIndex + 1);
    } else {
      boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevBoundaryIndex + 1;
    }
  }
  const boundaryEnd = effectiveEntries.length;

  const contextMessages = buildSessionContext(pathEntries).messages;
  // Without an admitted ID, only the latest input belongs to this run; do not revive older work.
  const requestEntryId = constraints?.requestBoundary?.entryId;
  const admittedIndex = requestEntryId
    ? pathEntries.findIndex((entry) => entry.id === requestEntryId)
    : -1;
  const admittedEntry = pathEntries[admittedIndex];
  // Recovery hydrates only the latest semantic window. A processed request may already
  // be summarized there; unprocessed input must still exist verbatim.
  const requestWasCompacted = Boolean(
    requestEntryId &&
    !admittedEntry &&
    !constraints?.requestBoundary?.preserve &&
    pathEntries[prevBoundaryIndex]?.type === "compaction",
  );
  if (
    requestEntryId &&
    !requestWasCompacted &&
    (!admittedEntry || getMessageFromEntryForCompaction(admittedEntry)?.role !== "user")
  ) {
    return err(
      new CompactionError("invalid_session", "Compaction cannot find the admitted request."),
    );
  }
  const latestInput = contextMessages.findLast((message) => message.role === "user");
  const requestStartIndex = requestWasCompacted ? prevBoundaryIndex + 1 : admittedIndex;
  const requestMessages =
    requestStartIndex >= 0
      ? pathEntries.slice(requestStartIndex).flatMap((entry) => {
          const message = getMessageFromEntryForCompaction(entry);
          return message ? [message] : [];
        })
      : latestInput
        ? [latestInput]
        : [];
  const hasRequestInput = requestMessages.some((message) => message.role === "user");
  const selectedRequest = requestState
    ? (extractLatestUserRequest(requestMessages) ??
      (hasRequestInput && !requestWasCompacted ? undefined : previousLatestUnresolvedUserRequest))
    : undefined;
  const requestSelection: CompactionPreparation["requestSelection"] = requestState
    ? selectedRequest
      ? { state: "unresolved", request: selectedRequest }
      : { state: "none" }
    : undefined;
  const contextUsage = estimateContextTokens(contextMessages);
  const tokensBefore = contextUsage.tokens;
  const totalEstimatedTokens = contextMessages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  // Provider usage includes prompt/schema tokens omitted by estimateTokens. Normalize its trigger
  // units to the cut walk, capped at a one-token retained tail; otherwise a small transcript
  // can leave the cut at the first entry and free nothing.
  const triggerUnitScale =
    !constraints?.budget &&
    totalEstimatedTokens > 0 &&
    Number.isFinite(totalEstimatedTokens) &&
    Number.isFinite(contextUsage.usageTokens)
      ? Math.min(
          Math.max(1, settings.keepRecentTokens),
          Math.max(1, contextUsage.usageTokens / totalEstimatedTokens),
        )
      : 1;
  const resetPreludeTokens = resetPreludeMessages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  // The reset prelude is always part of the summarization request. Count it like
  // other model-visible boundary context so a large kept tail moves the cut earlier.
  const keepRecentTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    settings.keepRecentTokens / triggerUnitScale + resetPreludeTokens,
  );

  const cutPoint = findCutPoint(
    effectiveEntries,
    boundaryStart,
    boundaryEnd,
    keepRecentTokens,
    constraints,
  );
  if (cutPoint.firstKeptEntryIndex === boundaryEnd) {
    return err(
      new CompactionError(
        "summarization_failed",
        "No complete recent message fits beside the foreground prompt, tools, and summary. Reduce the request or select a larger context window.",
      ),
    );
  }
  const firstKeptEntry = effectiveEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize: AgentMessage[] = [...resetPreludeMessages];
  const turnPrefixMessages: AgentMessage[] = [];
  for (let i = boundaryStart; i < cutPoint.firstKeptEntryIndex; i++) {
    const entry = effectiveEntries.at(i);
    const msg = entry ? getMessageFromEntryForCompaction(entry) : undefined;
    if (msg && entry) {
      onMessageProjection?.(entry, msg);
      (i < historyEnd ? messagesToSummarize : turnPrefixMessages).push(msg);
    }
  }
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return ok(undefined);
  }
  const fileOps = createFileOps();
  if (previousSummaryDetails) {
    mergeSummaryFileOperations(fileOps, previousSummaryDetails);
  }
  extractFileOpsFromMessages(
    [...messagesToSummarize, ...(cutPoint.isSplitTurn ? turnPrefixMessages : [])],
    fileOps,
  );

  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    ...(requestSelection ? { requestSelection } : {}),
    ...(selectedRequest ? { latestUnresolvedUserRequest: selectedRequest } : {}),
    tokensBefore,
    previousSummary,
    previousSummaryDetails,
    fileOps,
    settings,
  });
}
