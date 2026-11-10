import type { Model, ModelRequestHeaders, StreamFn } from "@openclaw/llm-core";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentCoreCompletionRuntimeDeps } from "../../runtime-deps.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import { CompactionError, err, ok, type Result } from "../types.js";
import type { CompactionDetails } from "./compaction-details.js";
import type { IndexedCompactionPreparation } from "./compaction-preparation.js";
import {
  capCompactionSummary,
  fitCompactionSummary,
  SUMMARY_TRUNCATED_MARKER,
} from "./compaction-summary-budget.js";
import { resolveCompactionThreshold } from "./compaction-threshold.js";
import {
  runSummarizationCompletion,
  type SummarizationConversationSource,
} from "./summarization-completion.js";
import { buildSummaryCheckpointPrompt } from "./summary-checkpoint-prompt.js";
import {
  clearCompactionPendingAskSection,
  computeFileLists,
  type FileOperations,
  formatCompactionUserLabel,
  formatFileOperations,
  getCompactionContent,
  removeGeneratedCompactionSection,
} from "./utils.js";

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

export {
  calculateContextTokens,
  estimateContextTokens,
  getLastAssistantUsage,
  type ContextUsageEstimate,
  prepareCompaction,
  prepareCompactionFromSource,
  iterateCompactionMessages,
  type CompactionAgentMessageSource,
  type CompactionContextProjection,
  type IndexedCompactionPreparation,
} from "./compaction-preparation.js";

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
  const tailBudget = contentBudget - headBudget;
  return `${truncateUtf16Safe(source, headBudget)}${REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(source, -tailBudget)}`;
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

const SUMMARIZATION_PROMPT = buildSummaryCheckpointPrompt({
  introduction:
    "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.",
  goal: "[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]",
  constraints:
    '- [Any constraints, preferences, or requirements mentioned by user]\n- [Or "(none)" if none were mentioned]',
  inProgress: "- [ ] [Current work]",
  blocked: "- [Issues preventing progress, if any]",
  decisions: "- **[Decision]**: [Brief rationale]",
  nextSteps: "1. [Ordered list of what should happen next]",
  criticalContext:
    '- [Any data, examples, or references needed to continue]\n- [Or "(none)" if not applicable]',
});

const UPDATE_SUMMARIZATION_PROMPT = buildSummaryCheckpointPrompt({
  introduction: `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed. Record checks that ran and their results as completed, even when they failed; keep unresolved blockers separate.
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it`,
  goal: "[Preserve existing goals, add new ones if the task expanded]",
  constraints: "- [Preserve existing, add new ones discovered]",
  done: "- [x] [Include previously done items AND newly completed items]",
  inProgress: "- [ ] [Current work - update based on progress]",
  blocked: "- [Current blockers - remove if resolved]",
  decisions: "- **[Decision]**: [Brief rationale] (preserve all previous, add new)",
  nextSteps: "1. [Update based on current state]",
  criticalContext: "- [Preserve important context, add new if needed]",
});

/** Caller-owned formats replace the default headings; focus remains additive. */
export type CompactionSummaryPrompt =
  | { kind: "turn-prefix" }
  | { kind: "custom"; instructions: string };

export async function generateSummary(
  currentMessages: AgentMessage[] | SummarizationConversationSource,
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
  const maxTokens = Math.min(
    Math.floor((summaryPrompt?.kind === "turn-prefix" ? 0.5 : 0.8) * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const selectedPrompt =
    summaryPrompt?.kind === "turn-prefix"
      ? TURN_PREFIX_SUMMARIZATION_PROMPT
      : summaryPrompt?.instructions;
  const promptWithoutProvenance = summaryPrompt
    ? [
        previousSummary &&
          "Update the previous summary with the new conversation. Preserve relevant facts, decisions, and unresolved asks; remove stale or duplicate detail. Use the format below.",
        selectedPrompt,
      ]
        .filter(Boolean)
        .join("\n\n")
    : previousSummary
      ? UPDATE_SUMMARIZATION_PROMPT
      : SUMMARIZATION_PROMPT;
  return await runSummarizationCompletion({
    messages: currentMessages,
    prompt: promptWithoutProvenance,
    customInstructions,
    previousSummary,
    model,
    maxTokens,
    apiKey,
    headers,
    signal,
    thinkingLevel,
    streamFn,
    runtime,
    errorLabel:
      summaryPrompt?.kind === "turn-prefix" ? "Turn prefix summarization" : "Summarization",
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

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export { serializeConversation } from "./utils.js";

export async function compact(
  preparation:
    | CompactionPreparation
    | (Omit<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages"> & {
        messagesToSummarize: SummarizationConversationSource;
        turnPrefixMessages: SummarizationConversationSource;
      }),
  model: Model,
  apiKey: string | undefined,
  headers?: ModelRequestHeaders,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  runtime?: AgentCoreCompletionRuntimeDeps,
): Promise<Result<CompactionResult, CompactionError>> {
  const {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    previousSummary,
    settings,
  } = preparation;
  if (!firstKeptEntryId) {
    return err(
      new CompactionError(
        "invalid_session",
        "First kept entry has no UUID - session may need migration",
      ),
    );
  }

  const summarize = (
    messages: AgentMessage[] | SummarizationConversationSource,
    previous?: string,
    summaryPrompt?: CompactionSummaryPrompt,
  ) =>
    generateSummary(
      messages,
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
    );
  const summarizeTurnPrefix = isSplitTurn && turnPrefixMessages.length > 0;
  const historyResult =
    messagesToSummarize.length > 0 || !summarizeTurnPrefix
      ? await summarize(messagesToSummarize, previousSummary)
      : ok<string, CompactionError>(
          previousSummaryWithoutFileOperations(preparation) ?? "No prior history.",
        );
  if (!historyResult.ok) {
    return err(historyResult.error);
  }

  let latestContext = "";
  if (summarizeTurnPrefix) {
    const turnPrefixResult = await summarize(turnPrefixMessages, undefined, {
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
  preparation: CompactionPreparation | IndexedCompactionPreparation,
): Result<CompactionResult<CompactionDetails>, CompactionError> {
  const droppedCount =
    preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
  const prefix = preparation.turnPrefixMessages;
  let sourceMessage: Extract<AgentMessage, { role: "user" }> | undefined;
  if (preparation.isSplitTurn) {
    const lastUserIndex =
      "turnPrefixSourceAskIndex" in preparation
        ? preparation.turnPrefixSourceAskIndex
        : prefix.length - 1;
    for (let index = lastUserIndex; index >= 0; index--) {
      const message = Array.isArray(prefix) ? prefix[index] : prefix.get(index);
      if (message?.role === "user" && getCompactionContent(message.content).text.trim()) {
        sourceMessage = message;
        break;
      }
    }
  }
  const sourceText = sourceMessage ? getCompactionContent(sourceMessage.content).text : "";
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
function previousSummaryWithoutFileOperations(
  preparation: Omit<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages">,
): string | undefined {
  const { previousSummary, previousSummaryDetails } = preparation;
  const previousRequest = previousSummaryDetails?.latestUnresolvedUserRequest;
  const previousRequestSection = previousRequest
    ? `## Latest unresolved user request\n${JSON.stringify(previousRequest)}\n\n`
    : "";
  const summaryWithoutRequest =
    preparation.requestSelection !== undefined && previousRequestSection
      ? removeGeneratedCompactionSection(previousSummary, previousRequestSection)
      : previousSummary;
  const reconciledSummary =
    preparation.requestSelection?.state === "none" && summaryWithoutRequest
      ? clearCompactionPendingAskSection(summaryWithoutRequest)
      : summaryWithoutRequest;
  const previousFileOperations = previousSummaryDetails
    ? formatFileOperations(previousSummaryDetails.readFiles, previousSummaryDetails.modifiedFiles)
    : "";
  return previousFileOperations && reconciledSummary?.endsWith(previousFileOperations)
    ? reconciledSummary.slice(0, -previousFileOperations.length)
    : reconciledSummary;
}

function finalizeCompaction(
  preparation: Omit<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages">,
  historySummary: string,
  latestContext: string,
  requiredContext = "",
): Result<CompactionResult<CompactionDetails>, CompactionError> {
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
        historySummary.length,
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
          `${historySummary}${suffix}`,
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
    },
  });
}
