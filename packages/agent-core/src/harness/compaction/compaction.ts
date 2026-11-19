import type { Model, ModelRequestHeaders, StreamFn } from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentCoreCompletionRuntimeDeps } from "../../runtime-deps.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import { CompactionError, err, ok, type Result, type SessionTreeEntry } from "../types.js";
import type { CompactionRetentionConstraints } from "./compaction-cut-point.js";
import type { CompactionDetails } from "./compaction-details.js";
import { prepareCompactionEntries } from "./compaction-preparation.js";
import { runSummarizationCompletion } from "./summarization-completion.js";
import { prepareCompactionSummaryRequest } from "./summary-checkpoint-prompt.js";
import {
  clearCompactionPendingAskSection,
  computeFileLists,
  extractCompactionMessageText,
  type FileOperations,
  formatCompactionUserLabel,
  formatFileOperations,
  removeGeneratedCompactionSection,
} from "./utils.js";

export {
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  IMAGE_BLOCK_TOKENS,
} from "./compaction-cut-point.js";

export type { CompactionDetails } from "./compaction-details.js";

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactionResult<T = unknown> {
  /** Summary text that replaces compacted history in future context. */
  summary: string;
  /** Entry id where retained history starts. */
  firstKeptEntryId: string;
  tokensBefore: number;
  /** Optional implementation-specific details stored with the compaction entry. */
  details?: T;
}

// Persisted summaries replay on every later request, so their owner enforces
// this provider-independent default unless the operator chooses another ceiling.
export const MAX_COMPACTION_SUMMARY_CHARS = 16_000;
export const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const TURN_CONTEXT_PREFIX = "\n\n---\n\n**Turn Context (split turn):**\n\n";
const MAX_REQUIRED_ASK_CONTEXT_CHARS = 2_000;
const REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER = "\n[... split-turn ask context truncated ...]\n";

/** Bounds a split turn's source ask; the safeguard summary and the no-summary reduction share it. */
export function formatRequiredAskContext(rawAsk: string): string {
  const source = rawAsk.trim();
  if (source.length <= MAX_REQUIRED_ASK_CONTEXT_CHARS) {
    return source;
  }
  const contentBudget =
    MAX_REQUIRED_ASK_CONTEXT_CHARS - REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  return `${truncateUtf16Safe(source, headBudget)}${REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(source, -(contentBudget - headBudget))}`;
}

export function capCompactionSummary(
  summary: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
  preservedSuffix = "",
) {
  if (maxChars <= 0 || summary.length <= maxChars) {
    return summary;
  }
  const suffix = preservedSuffix && summary.endsWith(preservedSuffix) ? preservedSuffix : "";
  if (maxChars < SUMMARY_TRUNCATED_MARKER.length + suffix.length) {
    return truncateUtf16Safe(summary, maxChars);
  }
  const budget = maxChars - SUMMARY_TRUNCATED_MARKER.length - suffix.length;
  const prefix = suffix ? summary.slice(0, -suffix.length) : summary;
  return `${truncateUtf16Safe(prefix, budget)}${SUMMARY_TRUNCATED_MARKER}${suffix}`;
}

/** Let each summary owner preserve its structure before checking the foreground token budget. */
export function fitCompactionSummary<T extends { summary: string }>(
  tokenBudget: number | undefined,
  render: (maxChars: number) => T | undefined,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): Result<T, CompactionError> {
  const fits = (candidate: T) =>
    tokenBudget === undefined ||
    estimateStringChars(candidate.summary) / CHARS_PER_TOKEN_ESTIMATE <= tokenBudget;
  const full = render(maxChars);
  if (full && fits(full)) {
    return ok(full);
  }
  let low = 1;
  let high = maxChars - 1;
  let fitted: T | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = render(mid);
    if (!candidate) {
      low = mid + 1;
    } else if (fits(candidate)) {
      fitted = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return fitted
    ? ok(fitted)
    : err(
        new CompactionError(
          "summarization_failed",
          "The compaction summary cannot fit beside the foreground prompt and retained history.",
        ),
      );
}

export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

export interface CompactionSettings {
  /** Persisted summary character ceiling; omission preserves the 16,000-character default. */
  maxSummaryChars?: number;
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export {
  calculateContextTokens,
  estimateContextTokens,
  getLastAssistantUsage,
} from "./compaction-preparation.js";

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return false;
  }
  return contextTokens > contextWindow - settings.reserveTokens;
}

/** Caller-owned formats replace the default headings; focus remains additive. */
export type CompactionSummaryPrompt =
  | { kind: "turn-prefix" }
  | { kind: "custom"; instructions: string };

export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: ModelRequestHeaders,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
  summaryPrompt?: CompactionSummaryPrompt,
): Promise<Result<string, CompactionError>> {
  return await runSummarizationCompletion({
    messages: currentMessages,
    ...prepareCompactionSummaryRequest({ model, reserveTokens, previousSummary, summaryPrompt }),
    customInstructions,
    previousSummary,
    model,
    apiKey,
    headers,
    signal,
    thinkingLevel,
    streamFn,
    runtime,
  });
}

export interface CompactionPreparation {
  /** Remaining foreground summary tokens, independent of the summarizer's context window. */
  summaryTokenBudget?: number;
  /** Entry id where retained history starts. */
  firstKeptEntryId: string;
  /** Messages summarized into the history summary. */
  messagesToSummarize: AgentMessage[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  /** Run-owner selection; absent for legacy callers that infer from transcript history. */
  requestSelection?: { state: "unresolved"; request: string } | { state: "none" };
  /** Bounded unresolved request projected for existing extension consumers. */
  latestUnresolvedUserRequest?: string;
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  /** File metadata already appended to the previous compaction summary. */
  previousSummaryDetails?: CompactionDetails;
  /** File operations extracted from summarized history. */
  fileOps: FileOperations;
  settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
  pathEntries: SessionTreeEntry[],
  settings: CompactionSettings,
  requestState?: "unresolved",
  constraints?: CompactionRetentionConstraints,
): Result<CompactionPreparation | undefined, CompactionError> {
  return prepareCompactionEntries(pathEntries, settings, requestState, constraints);
}

export { serializeConversation } from "./utils.js";

export async function compact(
  preparation: CompactionPreparation,
  model: Model,
  apiKey: string | undefined,
  headers?: ModelRequestHeaders,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<Result<CompactionResult, CompactionError>> {
  const { messagesToSummarize, turnPrefixMessages, settings } = preparation;
  return compactFromSource(
    preparation,
    { history: messagesToSummarize.length, turnPrefix: turnPrefixMessages.length },
    (source, previous, summaryPrompt) =>
      generateSummary(
        source === "history" ? messagesToSummarize : turnPrefixMessages,
        model,
        settings.reserveTokens,
        apiKey,
        headers,
        signal,
        customInstructions,
        previous,
        thinkingLevel,
        streamFn,
        runtime,
        summaryPrompt,
      ),
  );
}

export type CompactionSummaryPreparation = Omit<
  CompactionPreparation,
  "messagesToSummarize" | "turnPrefixMessages"
>;

/** Array and worker sources share summary ordering, failure handling and artifact fitting. */
export async function compactFromSource(
  preparation: CompactionSummaryPreparation,
  counts: { history: number; turnPrefix: number },
  summarize: (
    source: "history" | "turnPrefix",
    previous?: string,
    summaryPrompt?: CompactionSummaryPrompt,
  ) => Promise<Result<string, CompactionError>>,
): Promise<Result<CompactionResult, CompactionError>> {
  const { isSplitTurn, previousSummary } = preparation;
  if (!preparation.firstKeptEntryId) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }

  const summarizeTurnPrefix = isSplitTurn && counts.turnPrefix > 0;
  const historyResult =
    counts.history > 0 || !summarizeTurnPrefix
      ? await summarize("history", previousSummary)
      : ok<string, CompactionError>(
          previousSummaryWithoutFileOperations(preparation) ?? "No prior history.",
        );
  if (!historyResult.ok) {
    return err(historyResult.error);
  }

  let latestContext = "";
  if (summarizeTurnPrefix) {
    const turnPrefixResult = await summarize("turnPrefix", undefined, {
      kind: "turn-prefix",
    });
    if (!turnPrefixResult.ok) {
      return err(turnPrefixResult.error);
    }
    latestContext = `${TURN_CONTEXT_PREFIX}${turnPrefixResult.value}`;
  }
  return finalizeCompaction(preparation, historyResult.value, latestContext);
}

/**
 * Builds the same commit-ready artifact without a model call, for when summary
 * generation failed. The prepared cut keeps the recent suffix verbatim; the
 * previous summary, a split turn's raw source ask, file operations, and the
 * unresolved request carry forward, and the dropped span is named, not summarized.
 */
export function compactWithoutSummary(
  preparation: CompactionPreparation,
): Result<CompactionResult, CompactionError> {
  const droppedCount =
    preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
  const sourceMessage = preparation.isSplitTurn
    ? preparation.turnPrefixMessages.findLast(
        (message): message is Extract<AgentMessage, { role: "user" }> =>
          message.role === "user" && Boolean(extractCompactionMessageText(message)),
      )
    : undefined;
  const sourceText = sourceMessage ? extractCompactionMessageText(sourceMessage) : "";
  const sourceLabel = sourceMessage ? formatCompactionUserLabel(sourceMessage) : "User";
  const sourceAsk = sourceMessage
    ? formatRequiredAskContext(
        sourceLabel === "User" ? sourceText : `[${sourceLabel}]: ${sourceText}`,
      )
    : "";
  // Keep the notice and bounded source ask; shrink only the carried summary.
  const requiredContext =
    `[${droppedCount} earlier message(s) were removed without a summary because summarization failed. The messages after this summary are verbatim; ask the user if older details matter.]\n\n` +
    (sourceAsk ? `## Original request of the current turn\n${JSON.stringify(sourceAsk)}\n\n` : "");
  return finalizeCompaction(
    preparation,
    previousSummaryWithoutFileOperations(preparation) ?? "",
    "",
    requiredContext,
  );
}

// File metadata is re-merged by finalizeCompaction, so the carried summary drops its old copy.
function previousSummaryWithoutFileOperations(preparation: CompactionSummaryPreparation) {
  const { previousSummary, previousSummaryDetails } = preparation;
  const previousFileOperations = previousSummaryDetails
    ? formatFileOperations(previousSummaryDetails.readFiles, previousSummaryDetails.modifiedFiles)
    : "";
  return previousFileOperations && previousSummary?.endsWith(previousFileOperations)
    ? previousSummary.slice(0, -previousFileOperations.length)
    : previousSummary;
}

function finalizeCompaction(
  preparation: CompactionSummaryPreparation,
  historySummary: string,
  latestContext: string,
  requiredContext = "",
): Result<CompactionResult, CompactionError> {
  const previousRequest = preparation.previousSummaryDetails?.latestUnresolvedUserRequest;
  const summaryWithoutPreviousRequest =
    preparation.requestSelection !== undefined && previousRequest
      ? (removeGeneratedCompactionSection(
          historySummary,
          `## Latest unresolved user request\n${JSON.stringify(previousRequest)}\n\n`,
        ) ?? "")
      : historySummary;
  const reconciledHistorySummary =
    preparation.requestSelection?.state === "none"
      ? clearCompactionPendingAskSection(summaryWithoutPreviousRequest)
      : summaryWithoutPreviousRequest;
  const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
  const fileOperations = formatFileOperations(readFiles, modifiedFiles);
  // Required prefix content survives fitting; only the history and split-turn context shrink.
  const requiredPrefix = `${requiredContext}${
    preparation.latestUnresolvedUserRequest
      ? `## Latest unresolved user request\n${JSON.stringify(preparation.latestUnresolvedUserRequest)}\n\n`
      : ""
  }`;
  const fitted = fitCompactionSummary(
    preparation.summaryTokenBudget,
    (maxChars) => {
      const requiredChars = fileOperations.length + requiredPrefix.length;
      if (maxChars <= requiredChars + SUMMARY_TRUNCATED_MARKER.length) {
        return undefined;
      }
      const preservedHistoryChars = Math.min(
        reconciledHistorySummary.length,
        Math.floor(
          (preparation.summaryTokenBudget === undefined ? maxChars : maxChars - requiredChars) / 2,
        ),
      );
      const latestContextBudget =
        maxChars - requiredChars - SUMMARY_TRUNCATED_MARKER.length - preservedHistoryChars;
      // Fitting must keep generated split-turn context beside required metadata,
      // including its heading and loss marker when that context is shortened.
      if (
        preparation.summaryTokenBudget !== undefined &&
        latestContext &&
        latestContextBudget < TURN_CONTEXT_PREFIX.length + SUMMARY_TRUNCATED_MARKER.length + 1
      ) {
        return undefined;
      }
      const suffix = `${latestContextBudget > 0 ? capCompactionSummary(latestContext, latestContextBudget) : ""}${fileOperations}`;
      return {
        summary: `${requiredPrefix}${capCompactionSummary(
          `${reconciledHistorySummary}${suffix}`,
          maxChars - requiredPrefix.length,
          suffix,
        )}`,
      };
    },
    preparation.settings.maxSummaryChars,
  );
  if (!fitted.ok) {
    return fitted;
  }

  return ok({
    summary: fitted.value.summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: {
      readFiles,
      modifiedFiles,
      ...(preparation.latestUnresolvedUserRequest
        ? { latestUnresolvedUserRequest: preparation.latestUnresolvedUserRequest }
        : {}),
    } as CompactionDetails,
  });
}
