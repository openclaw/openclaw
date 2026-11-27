import { resolveCompactionThreshold } from "@openclaw/ai/internal/shared";
import type { Model, ModelRequestHeaders, StreamFn } from "@openclaw/llm-core";
import type { AgentCoreCompletionRuntimeDeps } from "../../runtime-deps.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import type { CompactionError, Result, SessionTreeEntry } from "../types.js";
import { compactFromSource } from "./compaction-assembly.js";
import type { CompactionRetentionConstraints } from "./compaction-cut-point.js";
import type { CompactionDetails } from "./compaction-details.js";
import { prepareCompactionEntries } from "./compaction-preparation.js";
import { runSummarizationCompletion } from "./summarization-completion.js";
import { prepareCompactionSummaryRequest } from "./summary-checkpoint-prompt.js";
import type { FileOperations } from "./utils.js";

export { compactFromSource, compactWithoutSummary } from "./compaction-assembly.js";

export {
  calculateContextTokens,
  getLastAssistantUsage,
  estimateContextTokens,
} from "./compaction-preparation.js";

export {
  capCompactionSummary,
  fitCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
} from "./compaction-summary-budget.js";

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

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return false;
  }
  return (
    contextTokens >
    resolveCompactionThreshold({
      contextWindowTokens: contextWindow,
      reserveTokensFloor: settings.reserveTokens,
    })
  );
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

/** Public SDK preparation keeps source-observation details inside the internal owner. */
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
  return compactFromSource(
    preparation,
    {
      history: preparation.messagesToSummarize.length,
      turnPrefix: preparation.turnPrefixMessages.length,
    },
    (source, previous, summaryPrompt) =>
      generateSummary(
        source === "history" ? preparation.messagesToSummarize : preparation.turnPrefixMessages,
        model,
        preparation.settings.reserveTokens,
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

/** Scalar preparation shared by the eager SDK and dedicated transcript view. */
export type CompactionPreparationMetadata = Omit<
  CompactionPreparation,
  "messagesToSummarize" | "turnPrefixMessages"
>;
