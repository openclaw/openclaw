import type { Usage } from "@openclaw/llm-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { iterateSessionContextMessages } from "../session/session.js";
import { selectResetKeptEntries } from "../session/tool-result-pairing.js";
import { CompactionError, err, ok, type Result, type SessionTreeEntry } from "../types.js";
import {
  estimateTokens,
  findCutPointFromSource,
  getMessageFromEntryForCompaction,
  type CompactionRetentionConstraints,
} from "./compaction-cut-point.js";
import {
  type CompactionDetails,
  MAX_LATEST_USER_REQUEST_CHARS,
  parseCompactionDetails,
} from "./compaction-details.js";
import type { CompactionEntrySource } from "./compaction-entry-source.js";
import type { CompactionPreparation, CompactionSettings } from "./compaction.js";
import {
  createFileOps,
  extractFileOpsFromMessages,
  findLatestCompactionUserMessage,
  type FileOperations,
  getCompactionContent,
  mergeSummaryFileOperations,
} from "./utils.js";

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

export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number;
  /** Tokens reported by the most recent assistant usage block. */
  usageTokens: number;
  /** Estimated tokens not covered by usable provider usage. */
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
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

const LATEST_USER_REQUEST_TRUNCATED_MARKER = "\n[... latest user request truncated ...]\n";

function extractLatestUserRequest(messages: AgentMessage[]): string | undefined {
  const message = findLatestCompactionUserMessage(
    messages,
    (candidate) => getCompactionContent(candidate.content).text,
  );
  const source = message ? getCompactionContent(message.content).text.trim() : "";
  if (!source || source.length <= MAX_LATEST_USER_REQUEST_CHARS) {
    return source || undefined;
  }
  const contentBudget = MAX_LATEST_USER_REQUEST_CHARS - LATEST_USER_REQUEST_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  return `${truncateUtf16Safe(source, headBudget)}${LATEST_USER_REQUEST_TRUNCATED_MARKER}${sliceUtf16Safe(source, -(contentBudget - headBudget))}`;
}

/** One forward pass retains usage and the bounded request, never the conversation. */
function measureCompactionContext(messages: Iterable<AgentMessage>) {
  let usageTokens = 0;
  let lastUsageIndex: number | null = null;
  let trailingTokens = 0;
  let totalEstimatedTokens = 0;
  let latestInputRequest: string | undefined;
  let hasLatestInput = false;
  let index = 0;
  for (const message of messages) {
    const tokens = estimateTokens(message);
    totalEstimatedTokens += tokens;
    if (isUnavailableContextBarrier(message)) {
      usageTokens = 0;
      lastUsageIndex = null;
    } else {
      const usage = getAssistantUsage(message);
      if (usage && usage.contextUsage?.state !== "unavailable") {
        usageTokens = calculateContextTokens(usage);
        lastUsageIndex = index;
        trailingTokens = -tokens;
      }
    }
    trailingTokens += tokens;
    if (message.role === "user") {
      hasLatestInput = true;
      latestInputRequest = extractLatestUserRequest([message]);
    }
    index += 1;
  }
  if (lastUsageIndex === null) {
    trailingTokens = totalEstimatedTokens;
  }
  return {
    usage: {
      tokens: usageTokens + trailingTokens,
      usageTokens,
      trailingTokens,
      lastUsageIndex,
    },
    totalEstimatedTokens,
    latestInputRequest,
    hasLatestInput,
  };
}

/** Raw messages remain in their snapshot until a consumer asks for one index. */
export interface CompactionAgentMessageSource {
  readonly length: number;
  get(index: number): AgentMessage | undefined;
}

export type IndexedCompactionPreparation = Omit<
  CompactionPreparation,
  "messagesToSummarize" | "turnPrefixMessages"
> & {
  messagesToSummarize: CompactionAgentMessageSource;
  turnPrefixMessages: CompactionAgentMessageSource;
  /** Latest nonempty user message in the prefix, recorded during its indexing pass. */
  turnPrefixSourceAskIndex: number;
};

/** The session-context owner supplies its canonical projection and reset selection. */
export interface CompactionContextProjection {
  messages(): Iterable<AgentMessage>;
  resetKeptEntryIndices(startIndex: number, endIndex: number): Iterable<number>;
}

export function* iterateCompactionMessages(
  source: CompactionAgentMessageSource,
): Generator<AgentMessage> {
  for (let i = 0; i < source.length; i++) {
    const message = source.get(i);
    if (message) {
      yield message;
    }
  }
}

function indexedMessages(
  entries: CompactionEntrySource,
  indices: readonly number[],
): CompactionAgentMessageSource {
  return {
    length: indices.length,
    get(index) {
      const entryIndex = indices[index];
      const entry = entryIndex === undefined ? undefined : entries.get(entryIndex);
      return entry ? getMessageFromEntryForCompaction(entry) : undefined;
    },
  };
}

function findEntryIndex(entries: CompactionEntrySource, id: string | undefined): number {
  if (!id) {
    return -1;
  }
  for (let i = 0; i < entries.length; i++) {
    if (entries.metadata(i)?.id === id) {
      return i;
    }
  }
  return -1;
}

/** Keep one call-bearing message and result flags; file extraction still owns matching. */
function extractIndexedFileOps(messages: Iterable<AgentMessage>, fileOps: FileOperations) {
  let frame: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult") {
      extractFileOpsFromMessages(frame, fileOps);
      frame =
        message.role === "assistant"
          ? [
              {
                role: "assistant",
                content: message.content.flatMap((block) => {
                  if (block.type !== "toolCall") {
                    return [];
                  }
                  const args = asOptionalRecord(block.arguments);
                  // These are the file-path inputs consumed by extractFileOpsFromMessages.
                  return [
                    {
                      type: "toolCall" as const,
                      id: block.id,
                      name: block.name,
                      arguments: {
                        path: typeof args?.path === "string" ? args.path : undefined,
                        file_path: typeof args?.file_path === "string" ? args.file_path : undefined,
                        filePath: typeof args?.filePath === "string" ? args.filePath : undefined,
                      },
                    },
                  ];
                }),
                api: "compaction-file-operations",
                provider: "compaction-file-operations",
                model: "",
                stopReason: message.stopReason,
                timestamp: 0,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              },
            ]
          : [];
      continue;
    }
    // Patch file summaries are extracted while the full result is available.
    extractFileOpsFromMessages([message], fileOps);
    if (frame.length > 0) {
      frame.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: [],
        details: { changed: asOptionalRecord(message.details)?.changed },
        isError: message.isError,
        timestamp: message.timestamp,
      });
    }
  }
  extractFileOpsFromMessages(frame, fileOps);
}

/** Array callers use the same planner, then explicitly materialize their legacy result. */
export function prepareCompaction(
  pathEntries: SessionTreeEntry[],
  settings: CompactionSettings,
  requestState?: "unresolved",
  constraints?: CompactionRetentionConstraints,
): Result<CompactionPreparation | undefined, CompactionError> {
  const result = prepareCompactionFromSource(
    {
      length: pathEntries.length,
      metadata: (index) => pathEntries[index],
      get: (index) => pathEntries[index],
    },
    {
      messages: () => iterateSessionContextMessages(pathEntries),
      resetKeptEntryIndices: (startIndex, endIndex) => {
        const retained = new Set(selectResetKeptEntries(pathEntries.slice(startIndex, endIndex)));
        const indices: number[] = [];
        for (let i = startIndex; i < endIndex; i++) {
          const entry = pathEntries[i];
          if (entry && retained.has(entry)) {
            indices.push(i);
          }
        }
        return indices;
      },
    },
    settings,
    requestState,
    constraints,
  );
  if (!result.ok) {
    return result;
  }
  if (!result.value) {
    return ok(undefined);
  }
  const { turnPrefixSourceAskIndex: _sourceAskIndex, ...preparation } = result.value;
  return ok({
    ...preparation,
    messagesToSummarize: Array.from(iterateCompactionMessages(result.value.messagesToSummarize)),
    turnPrefixMessages: Array.from(iterateCompactionMessages(result.value.turnPrefixMessages)),
  });
}

/** Prepare a stable indexed snapshot without retaining its hydrated message payloads. */
export function prepareCompactionFromSource(
  pathEntries: CompactionEntrySource,
  context: CompactionContextProjection,
  settings: CompactionSettings,
  requestState?: "unresolved",
  constraints?: CompactionRetentionConstraints,
): Result<IndexedCompactionPreparation | undefined, CompactionError> {
  const lastEntry = pathEntries.metadata(pathEntries.length - 1);
  const lastBoundary =
    lastEntry?.type === "compaction" ? pathEntries.get(pathEntries.length - 1) : undefined;
  if (
    !lastEntry ||
    lastEntry.type === "reset" ||
    (lastBoundary?.type === "compaction" && lastBoundary.fromHook)
  ) {
    // Safeguard-owned compactions are anti-loop boundaries for the current turn.
    return ok(undefined);
  }

  let prevBoundaryIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    const entry = pathEntries.metadata(i);
    if (entry?.type === "compaction" || entry?.type === "reset") {
      prevBoundaryIndex = i;
      break;
    }
  }

  let previousSummary: string | undefined;
  let previousSummaryDetails: CompactionDetails | undefined;
  let previousLatestUnresolvedUserRequest: string | undefined;
  let effectiveEntries = pathEntries;
  let resetPreludeIndices: number[] = [];
  let boundaryStart = 0;
  if (prevBoundaryIndex >= 0) {
    const prevBoundary = pathEntries.get(prevBoundaryIndex);
    previousSummary = prevBoundary?.type === "compaction" ? prevBoundary.summary : undefined;
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
    const firstKeptEntryIndex = findEntryIndex(pathEntries, firstKeptEntryId);
    if (prevBoundary?.type === "reset") {
      resetPreludeIndices =
        firstKeptEntryIndex >= 0
          ? Array.from(
              context.resetKeptEntryIndices(firstKeptEntryIndex, prevBoundaryIndex),
            ).filter((index) => {
              const entry = pathEntries.get(index);
              return entry && getMessageFromEntryForCompaction(entry);
            })
          : [];
      effectiveEntries = {
        length: pathEntries.length - prevBoundaryIndex - 1,
        metadata: (index) => pathEntries.metadata(index + prevBoundaryIndex + 1),
        get: (index) => pathEntries.get(index + prevBoundaryIndex + 1),
      };
    } else {
      boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevBoundaryIndex + 1;
    }
  }
  const boundaryEnd = effectiveEntries.length;

  const measuredContext = measureCompactionContext(context.messages());
  // Without an admitted ID, only the latest input belongs to this run; do not revive older work.
  const requestEntryId = constraints?.requestBoundary?.entryId;
  const admittedIndex = requestEntryId ? findEntryIndex(pathEntries, requestEntryId) : -1;
  const admittedEntry = pathEntries.get(admittedIndex);
  // Recovery hydrates only the latest semantic window. A processed request may already
  // be summarized there; unprocessed input must still exist verbatim.
  const requestWasCompacted = Boolean(
    requestEntryId &&
    !admittedEntry &&
    !constraints?.requestBoundary?.preserve &&
    pathEntries.metadata(prevBoundaryIndex)?.type === "compaction",
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
  const requestStartIndex = requestWasCompacted ? prevBoundaryIndex + 1 : admittedIndex;
  let hasRequestInput = measuredContext.hasLatestInput;
  let selectedRequest = measuredContext.latestInputRequest;
  if (requestStartIndex >= 0) {
    hasRequestInput = false;
    selectedRequest = undefined;
    for (let i = requestStartIndex; i < pathEntries.length; i++) {
      const entry = pathEntries.get(i);
      const message = entry ? getMessageFromEntryForCompaction(entry) : undefined;
      if (message?.role === "user") {
        hasRequestInput = true;
        selectedRequest = extractLatestUserRequest([message]) ?? selectedRequest;
      }
    }
  }
  selectedRequest = requestState
    ? (selectedRequest ??
      (hasRequestInput && !requestWasCompacted ? undefined : previousLatestUnresolvedUserRequest))
    : undefined;
  const requestSelection: CompactionPreparation["requestSelection"] = requestState
    ? selectedRequest
      ? { state: "unresolved", request: selectedRequest }
      : { state: "none" }
    : undefined;
  const contextUsage = measuredContext.usage;
  const tokensBefore = contextUsage.tokens;
  const totalEstimatedTokens = measuredContext.totalEstimatedTokens;
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
  const resetPreludeSource = indexedMessages(pathEntries, resetPreludeIndices);
  let resetPreludeTokens = 0;
  for (const message of iterateCompactionMessages(resetPreludeSource)) {
    resetPreludeTokens += estimateTokens(message);
  }
  // The reset prelude is always part of the summarization request. Count it like
  // other model-visible boundary context so a large kept tail moves the cut earlier.
  const keepRecentTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    settings.keepRecentTokens / triggerUnitScale + resetPreludeTokens,
  );

  const cutPoint = findCutPointFromSource(
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
  const firstKeptEntry = effectiveEntries.metadata(cutPoint.firstKeptEntryIndex);
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
  const historyIndices: number[] = [];
  const prefixIndices: number[] = [];
  let turnPrefixSourceAskIndex = -1;
  function* indexSummaryMessages() {
    yield* iterateCompactionMessages(resetPreludeSource);
    for (let i = boundaryStart; i < cutPoint.firstKeptEntryIndex; i++) {
      const navigation = effectiveEntries.metadata(i);
      // Text-only assistant payloads cannot contribute file outcomes or a user ask.
      // Keep their position (including pairing resets), without rereading their text.
      const entry =
        navigation?.type === "message" &&
        navigation.message.role === "assistant" &&
        !navigation.message.content.some((block) => block.type === "toolCall")
          ? navigation
          : effectiveEntries.get(i);
      const message = entry ? getMessageFromEntryForCompaction(entry) : undefined;
      if (!message) {
        continue;
      }
      if (i < historyEnd) {
        historyIndices.push(i);
      } else {
        if (message.role === "user" && getCompactionContent(message.content).text.trim()) {
          turnPrefixSourceAskIndex = prefixIndices.length;
        }
        prefixIndices.push(i);
      }
      yield message;
    }
  }
  const fileOps = createFileOps();
  if (previousSummaryDetails) {
    mergeSummaryFileOperations(fileOps, previousSummaryDetails);
  }
  // Index selection and file outcomes consume the same raw row while it is resident.
  extractIndexedFileOps(indexSummaryMessages(), fileOps);
  const history = indexedMessages(effectiveEntries, historyIndices);
  const messagesToSummarize: CompactionAgentMessageSource = {
    length: resetPreludeSource.length + history.length,
    get: (index) =>
      index < resetPreludeSource.length
        ? resetPreludeSource.get(index)
        : history.get(index - resetPreludeSource.length),
  };
  const turnPrefixMessages = indexedMessages(effectiveEntries, prefixIndices);
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return ok(undefined);
  }
  return ok({
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    turnPrefixSourceAskIndex,
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
