import type { Usage } from "@openclaw/llm-core";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import {
  buildSessionContext,
  collectSessionContextEntryFact,
  iterateSessionContextEntryFacts,
  projectSessionContextMessage,
  selectResetKeptContextEntryFacts,
  type SessionContextEntryFact,
} from "../session/session.js";
import { selectResetKeptEntries } from "../session/tool-result-pairing.js";
import {
  CompactionError,
  err,
  ok,
  type FileOperations,
  type Result,
  type SessionTreeEntry,
} from "../types.js";
import { copyString } from "../utils/truncate.js";
import {
  estimateTokens,
  findCutPoint,
  collectCompactionCutEntryFact,
  findCutPointFromFacts,
  type CompactionCutEntryFact,
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
  collectFileOperationMessageFact,
  extractFileOpsFromFacts,
  type FileOperationMessageFact,
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

export type CompactionContextUsageFact = {
  barrier: boolean;
  usageTokens?: number;
};

export function collectCompactionContextUsageFact(
  message: AgentMessage,
): CompactionContextUsageFact {
  const usage = getAssistantUsage(message);
  return {
    barrier: isUnavailableContextBarrier(message),
    usageTokens:
      usage && usage.contextUsage?.state !== "unavailable"
        ? calculateContextTokens(usage)
        : undefined,
  };
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  return estimateContextTokensFromFacts({
    length: messages.length,
    usageAt: (index) => {
      const message = messages[index];
      return message ? collectCompactionContextUsageFact(message) : undefined;
    },
    estimateAt: (index) => {
      const message = messages[index];
      if (!message) {
        throw new TypeError("Compaction context contains a missing message");
      }
      return estimateTokens(message);
    },
  });
}

/** Readers supply collected scalar facts; array callers estimate only the required tail. */
export function estimateContextTokensFromFacts(facts: {
  length: number;
  usageAt: (index: number) => CompactionContextUsageFact | undefined;
  estimateAt: (index: number) => number;
}): ContextUsageEstimate {
  let usageTokens = 0;
  let lastUsageIndex: number | null = null;
  for (let i = facts.length - 1; i >= 0; i--) {
    const fact = facts.usageAt(i);
    if (fact?.barrier) {
      // Synthetic CLI markers invalidate older usage without supplying a replacement.
      break;
    }
    if (fact?.usageTokens !== undefined) {
      usageTokens = fact.usageTokens;
      lastUsageIndex = i;
      break;
    }
  }
  let trailingTokens = 0;
  for (let i = lastUsageIndex === null ? 0 : lastUsageIndex + 1; i < facts.length; i++) {
    trailingTokens += facts.estimateAt(i);
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

type PreparationEntry = Pick<SessionContextEntryFact, "id" | "type" | "firstKeptEntryId"> & {
  fromHook?: boolean;
};
export type PreparationConstraints = Parameters<typeof findCutPointFromFacts>[4];
type Preparation<M> = Omit<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages"> & {
  /** Position in the supplied path, including any reset prefix; not the source locator. */
  firstKeptEntryIndex: number;
  messagesToSummarize: M[];
  turnPrefixMessages: M[];
};
type PreparationSource<T, M> = {
  message: (entry: T) => M | undefined;
  resetKept: (entries: T[]) => T[];
  context: (entries: readonly T[]) => M[];
  previous: (entry: T) => { summary?: string; details?: CompactionDetails };
  latestRequest: (messages: M[]) => string | undefined;
  usage: (message: M) => CompactionContextUsageFact;
  estimate: (message: M) => number;
  cut: (
    entries: readonly T[],
    start: number,
    end: number,
    keepTokens: number,
  ) => ReturnType<typeof findCutPoint>;
  files: (messages: M[], fileOps: FileOperations) => void;
  observe?: (entry: T, message: M) => void;
};

/** Public arrays retain message aliases, observation timing and opaque estimator call order. */
export function prepareCompactionEntries(
  pathEntries: SessionTreeEntry[],
  settings: CompactionSettings,
  requestState?: "unresolved",
  constraints?: CompactionRetentionConstraints,
  onMessageProjection?: CompactionMessageProjection,
): Result<CompactionPreparation | undefined, CompactionError> {
  const result = prepareCompactionSource(pathEntries, settings, requestState, constraints, {
    message: getMessageFromEntryForCompaction,
    resetKept: selectResetKeptEntries,
    context: (entries) => buildSessionContext(entries).messages,
    previous: (entry) =>
      entry.type === "compaction"
        ? {
            summary: stripSummaryFloor(entry.summary),
            details: parseCompactionDetails(entry.details),
          }
        : {},
    latestRequest: extractLatestUserRequest,
    usage: collectCompactionContextUsageFact,
    estimate: estimateTokens,
    cut: (entries, start, end, keepTokens) =>
      findCutPoint(entries, start, end, keepTokens, constraints),
    files: extractFileOpsFromMessages,
    observe: onMessageProjection,
  });
  if (!result.ok || !result.value) {
    return result;
  }
  const { firstKeptEntryIndex: _index, ...preparation } = result.value;
  return ok(preparation);
}

export type CompactionPreparationMessageFact = {
  sourceIndex: number;
  role: AgentMessage["role"];
  tokens: number;
  usage: CompactionContextUsageFact;
  latestUserRequest?: string;
  fileOps: FileOperationMessageFact;
};
export type CompactionPreparationEntryFact = SessionContextEntryFact &
  PreparationEntry & {
    /** Caller-owned row locator, preserved in history/prefix selections. */
    sourceIndex: number;
    cut: CompactionCutEntryFact;
    message?: CompactionPreparationMessageFact;
    contextMessage?: CompactionPreparationMessageFact;
    previousSummary?: string;
    previousSummaryDetails?: CompactionDetails;
  };

/** Only bounded requests, prior summaries and exact file/pairing facts survive each decoded row. */
export function collectCompactionPreparationEntryFact(
  entry: SessionTreeEntry,
  sourceIndex: number,
): CompactionPreparationEntryFact {
  const context = collectSessionContextEntryFact(entry);
  const message = getMessageFromEntryForCompaction(entry);
  const contextMessage = projectSessionContextMessage({
    entry,
    context: "reset-retained",
    placement: context.pendingBackground ? entry : undefined,
  });
  const collect = (value: AgentMessage): CompactionPreparationMessageFact => {
    const request = extractLatestUserRequest([value]);
    return {
      sourceIndex,
      role: value.role,
      tokens: estimateTokens(value),
      usage: collectCompactionContextUsageFact(value),
      latestUserRequest: request ? copyString(request) : undefined,
      fileOps: collectFileOperationMessageFact(value),
    };
  };
  const messageFact = message ? collect(message) : undefined;
  return {
    ...context,
    sourceIndex,
    cut: collectCompactionCutEntryFact(entry, message),
    message: messageFact,
    contextMessage: contextMessage ? (messageFact ?? collect(contextMessage)) : undefined,
    ...(entry.type === "compaction"
      ? {
          fromHook: entry.fromHook,
          previousSummary: stripSummaryFloor(entry.summary),
          previousSummaryDetails: parseCompactionDetails(entry.details),
        }
      : {}),
  };
}

export type CompactionFactPreparation = Omit<
  Preparation<CompactionPreparationMessageFact>,
  "messagesToSummarize" | "turnPrefixMessages"
> & {
  historyEntryIndexes: number[];
  turnPrefixEntryIndexes: number[];
};

/** The array adapter and one-row reader share preparation policy, cut and file-operation reducers. */
export function prepareCompactionEntryFacts<T extends CompactionPreparationEntryFact>(
  entries: readonly T[],
  settings: CompactionSettings,
  requestState?: "unresolved",
  constraints?: PreparationConstraints,
  estimateEntryTokens: (entry: T) => number = (entry) => entry.message?.tokens ?? 0,
): Result<CompactionFactPreparation | undefined, CompactionError> {
  const result = prepareCompactionSource(entries, settings, requestState, constraints, {
    message: (entry) => entry.message,
    resetKept: selectResetKeptContextEntryFacts,
    context: (path) =>
      Array.from(iterateSessionContextEntryFacts(path)).flatMap(({ entry }) =>
        entry.contextMessage ? [entry.contextMessage] : [],
      ),
    previous: (entry) => ({
      summary: entry.previousSummary,
      details: entry.previousSummaryDetails,
    }),
    latestRequest: (messages) =>
      messages.findLast((message) => message.latestUserRequest)?.latestUserRequest,
    usage: (message) => message.usage,
    estimate: (message) => message.tokens,
    cut: (path, start, end, keepTokens) =>
      findCutPointFromFacts(
        path.map((entry) => entry.cut),
        start,
        end,
        keepTokens,
        constraints,
        (index) => {
          const entry = path[index];
          return entry ? estimateEntryTokens(entry) : 0;
        },
      ),
    files: (messages, fileOps) =>
      extractFileOpsFromFacts(
        messages.map((message) => message.fileOps),
        fileOps,
      ),
  });
  if (!result.ok) {
    return result;
  }
  if (!result.value) {
    return ok(undefined);
  }
  const { messagesToSummarize, turnPrefixMessages, ...preparation } = result.value;
  return ok({
    ...preparation,
    historyEntryIndexes: messagesToSummarize.map((message) => message.sourceIndex),
    turnPrefixEntryIndexes: turnPrefixMessages.map((message) => message.sourceIndex),
  });
}

function prepareCompactionSource<
  T extends PreparationEntry,
  M extends { role: AgentMessage["role"] },
>(
  pathEntries: readonly T[],
  settings: CompactionSettings,
  requestState: "unresolved" | undefined,
  constraints: PreparationConstraints,
  source: PreparationSource<T, M>,
): Result<Preparation<M> | undefined, CompactionError> {
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
  let resetPreludeMessages: M[] = [];
  let boundaryStart = 0;
  if (prevBoundaryIndex >= 0) {
    const prevBoundary = pathEntries[prevBoundaryIndex];
    if (prevBoundary?.type === "compaction") {
      const previous = source.previous(prevBoundary);
      previousSummary = previous.summary;
      const details = previous.details;
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
          ? source.resetKept(pathEntries.slice(firstKeptEntryIndex, prevBoundaryIndex))
          : [];
      resetPreludeMessages = keptEntries.flatMap((entry) => {
        const message = source.message(entry);
        if (message) {
          source.observe?.(entry, message);
        }
        return message ? [message] : [];
      });
      effectiveEntries = pathEntries.slice(prevBoundaryIndex + 1);
    } else {
      boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevBoundaryIndex + 1;
    }
  }
  const boundaryEnd = effectiveEntries.length;

  const contextMessages = source.context(pathEntries);
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
    (!admittedEntry || source.message(admittedEntry)?.role !== "user")
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
          const message = source.message(entry);
          return message ? [message] : [];
        })
      : latestInput
        ? [latestInput]
        : [];
  const hasRequestInput = requestMessages.some((message) => message.role === "user");
  const selectedRequest = requestState
    ? (source.latestRequest(requestMessages) ??
      (hasRequestInput && !requestWasCompacted ? undefined : previousLatestUnresolvedUserRequest))
    : undefined;
  const requestSelection: CompactionPreparation["requestSelection"] = requestState
    ? selectedRequest
      ? { state: "unresolved", request: selectedRequest }
      : { state: "none" }
    : undefined;
  const contextUsage = estimateContextTokensFromFacts({
    length: contextMessages.length,
    usageAt: (index) => {
      const message = contextMessages[index];
      return message ? source.usage(message) : undefined;
    },
    estimateAt: (index) => {
      const message = contextMessages[index];
      if (!message) {
        throw new TypeError("Compaction context contains a missing message");
      }
      return source.estimate(message);
    },
  });
  const tokensBefore = contextUsage.tokens;
  const totalEstimatedTokens = contextMessages.reduce(
    (total, message) => total + source.estimate(message),
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
    (total, message) => total + source.estimate(message),
    0,
  );
  // The reset prelude is always part of the summarization request. Count it like
  // other model-visible boundary context so a large kept tail moves the cut earlier.
  const keepRecentTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    settings.keepRecentTokens / triggerUnitScale + resetPreludeTokens,
  );

  const cutPoint = source.cut(effectiveEntries, boundaryStart, boundaryEnd, keepRecentTokens);
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
  const messagesToSummarize: M[] = [...resetPreludeMessages];
  const turnPrefixMessages: M[] = [];
  for (let i = boundaryStart; i < cutPoint.firstKeptEntryIndex; i++) {
    const entry = effectiveEntries.at(i);
    const msg = entry ? source.message(entry) : undefined;
    if (msg && entry) {
      source.observe?.(entry, msg);
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
  source.files(
    [...messagesToSummarize, ...(cutPoint.isSplitTurn ? turnPrefixMessages : [])],
    fileOps,
  );

  return ok({
    firstKeptEntryId,
    firstKeptEntryIndex:
      cutPoint.firstKeptEntryIndex + (effectiveEntries === pathEntries ? 0 : prevBoundaryIndex + 1),
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
