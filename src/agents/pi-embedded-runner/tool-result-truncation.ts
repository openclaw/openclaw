import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { log } from "./logger.js";
import { formatContextLimitTruncationNotice } from "./tool-result-context-guard.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

/**
 * Maximum share of the context window a single tool result should occupy.
 * This is intentionally conservative – a single tool result should not
 * consume more than 30% of the context window even without other messages.
 */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/**
 * Default hard cap for a single live tool result text block.
 *
 * Pi already truncates tool results aggressively when serializing old history
 * for compaction summaries. For the live request path we still keep a bounded
 * request-local ceiling so oversized tool output cannot dominate the next turn.
 */
export const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 40_000;

/**
 * Backwards-compatible alias for older call sites/tests.
 */
export const HARD_MAX_TOOL_RESULT_CHARS = DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;

/**
 * Minimum characters to keep when truncating.
 * We always keep at least the first portion so the model understands
 * what was in the content.
 */
const MIN_KEEP_CHARS = 2_000;
const RECOVERY_MIN_KEEP_CHARS = 0;

type ToolResultTruncationOptions = {
  suffix?: string | ((truncatedChars: number) => string);
  minKeepChars?: number;
};

const DEFAULT_SUFFIX = (truncatedChars: number) =>
  formatContextLimitTruncationNotice(truncatedChars);
export const MIN_TRUNCATED_TEXT_CHARS = MIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;
const RECOVERY_MIN_TRUNCATED_TEXT_CHARS = RECOVERY_MIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;

/**
 * Marker inserted between head and tail when using head+tail truncation.
 */
const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";

/**
 * Detect whether text likely contains error/diagnostic content near the end,
 * which should be preserved during truncation.
 */
function hasImportantTail(text: string): boolean {
  // Check last ~2000 chars for error-like patterns
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    // JSON closing — if the output is JSON, the tail has closing structure
    /\}\s*$/.test(tail.trim()) ||
    // Summary/result lines often appear at the end
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

/**
 * Truncate a single text string to fit within maxChars.
 *
 * Uses a head+tail strategy when the tail contains important content
 * (errors, results, JSON structure), otherwise preserves the beginning.
 * This ensures error messages and summaries at the end of tool output
 * aren't lost during truncation.
 */
export function truncateToolResultText(
  text: string,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): string {
  const suffixFactory: (truncatedChars: number) => string =
    typeof options.suffix === "function"
      ? options.suffix
      : () => options.suffix ?? DEFAULT_SUFFIX(1);
  const minKeepChars = options.minKeepChars ?? MIN_KEEP_CHARS;
  if (text.length <= maxChars) {
    return text;
  }
  const defaultSuffix = suffixFactory(Math.max(1, text.length - maxChars));
  const budget = Math.max(minKeepChars, maxChars - defaultSuffix.length);

  // If tail looks important, split budget between head and tail
  if (hasImportantTail(text) && budget > minKeepChars * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;

    if (headBudget > minKeepChars) {
      // Find clean cut points at newline boundaries
      let headCut = headBudget;
      const headNewline = text.lastIndexOf("\n", headBudget);
      if (headNewline > headBudget * 0.8) {
        headCut = headNewline;
      }

      let tailStart = text.length - tailBudget;
      const tailNewline = text.indexOf("\n", tailStart);
      if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) {
        tailStart = tailNewline + 1;
      }

      const keptText = text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart);
      const suffix = suffixFactory(Math.max(1, text.length - keptText.length));
      return keptText + suffix;
    }
  }

  // Default: keep the beginning
  let cutPoint = budget;
  const lastNewline = text.lastIndexOf("\n", budget);
  if (lastNewline > budget * 0.8) {
    cutPoint = lastNewline;
  }
  const keptText = text.slice(0, cutPoint);
  const suffix = suffixFactory(Math.max(1, text.length - keptText.length));
  return keptText + suffix;
}

/**
 * Calculate the maximum allowed characters for a single tool result
 * based on the model's context window tokens.
 *
 * Uses a rough 4 chars ≈ 1 token heuristic (conservative for English text;
 * actual ratio varies by tokenizer).
 */
export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
  // Rough conversion: ~4 chars per token on average
  const maxChars = maxTokens * 4;
  return Math.min(maxChars, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
}

/**
 * Get the total character count of text content blocks in a tool result message.
 */
export function getToolResultTextLength(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let totalLength = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as TextContent).text;
      if (typeof text === "string") {
        totalLength += text.length;
      }
    }
  }
  return totalLength;
}

/**
 * Truncate a tool result message's text content blocks to fit within maxChars.
 * Returns a new message (does not mutate the original).
 */
export function truncateToolResultMessage(
  msg: AgentMessage,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): AgentMessage {
  const suffixFactory: (truncatedChars: number) => string =
    typeof options.suffix === "function"
      ? options.suffix
      : () => options.suffix ?? DEFAULT_SUFFIX(1);
  const minKeepChars = options.minKeepChars ?? MIN_KEEP_CHARS;
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  // Calculate total text size
  const totalTextChars = getToolResultTextLength(msg);
  if (totalTextChars <= maxChars) {
    return msg;
  }

  // Distribute the budget proportionally among text blocks
  const newContent = content.map((block: unknown) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      return block; // Keep non-text blocks (images) as-is
    }
    const textBlock = block as TextContent;
    if (typeof textBlock.text !== "string") {
      return block;
    }
    // Proportional budget for this block
    const blockShare = textBlock.text.length / totalTextChars;
    const defaultSuffix = suffixFactory(
      Math.max(1, textBlock.text.length - Math.floor(maxChars * blockShare)),
    );
    const blockBudget = Math.max(
      minKeepChars + defaultSuffix.length,
      Math.floor(maxChars * blockShare),
    );
    return {
      ...textBlock,
      text: truncateToolResultText(textBlock.text, blockBudget, {
        suffix: suffixFactory,
        minKeepChars,
      }),
    };
  });

  return { ...msg, content: newContent } as AgentMessage;
}

/**
 * Truncate oversized tool results in an array of messages (in-memory).
 * Returns a new array with truncated messages.
 *
 * This is used as a pre-emptive guard before sending messages to the LLM,
 * without modifying the session file.
 */
export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  contextWindowTokens: number,
): { messages: AgentMessage[]; truncatedCount: number } {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if ((msg as { role?: string }).role !== "toolResult") {
      return msg;
    }
    const textLength = getToolResultTextLength(msg);
    if (textLength <= maxChars) {
      return msg;
    }
    truncatedCount++;
    return truncateToolResultMessage(msg, maxChars);
  });

  return { messages: result, truncatedCount };
}

function calculateRecoveryAggregateToolResultChars(contextWindowTokens: number): number {
  return Math.max(
    calculateMaxToolResultChars(contextWindowTokens),
    RECOVERY_MIN_TRUNCATED_TEXT_CHARS,
  );
}

export type ToolResultReductionPotential = {
  maxChars: number;
  aggregateBudgetChars: number;
  toolResultCount: number;
  totalToolResultChars: number;
  oversizedCount: number;
  oversizedReducibleChars: number;
  aggregateReducibleChars: number;
  maxReducibleChars: number;
};

function buildAggregateToolResultReplacements(params: {
  branch: Array<{ id: string; type: string; message?: AgentMessage }>;
  aggregateBudgetChars: number;
  minKeepChars?: number;
}): Array<{ entryId: string; message: AgentMessage }> {
  const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
  const minTruncatedTextChars = minKeepChars + DEFAULT_SUFFIX(1).length;
  const candidates = params.branch
    .map((entry, index) => ({ entry, index }))
    .filter(
      (
        item,
      ): item is {
        entry: { id: string; type: string; message: AgentMessage };
        index: number;
      } =>
        item.entry.type === "message" &&
        Boolean(item.entry.message) &&
        (item.entry.message as { role?: string }).role === "toolResult",
    )
    .map((item) => ({
      entryId: item.entry.id,
      message: item.entry.message,
      textLength: getToolResultTextLength(item.entry.message),
    }))
    .filter((item) => item.textLength > 0);

  if (candidates.length < 2) {
    return [];
  }

  const totalChars = candidates.reduce((sum, item) => sum + item.textLength, 0);
  if (totalChars <= params.aggregateBudgetChars) {
    return [];
  }

  let remainingReduction = totalChars - params.aggregateBudgetChars;
  const replacements: Array<{ entryId: string; message: AgentMessage }> = [];

  for (const candidate of candidates.toSorted((a, b) => b.textLength - a.textLength)) {
    if (remainingReduction <= 0) {
      break;
    }
    const reducibleChars = Math.max(0, candidate.textLength - minTruncatedTextChars);
    if (reducibleChars <= 0) {
      continue;
    }

    const requestedReduction = Math.min(reducibleChars, remainingReduction);
    const targetChars = Math.max(minTruncatedTextChars, candidate.textLength - requestedReduction);
    const truncatedMessage = truncateToolResultMessage(candidate.message, targetChars, {
      minKeepChars,
    });
    const newLength = getToolResultTextLength(truncatedMessage);
    const actualReduction = Math.max(0, candidate.textLength - newLength);
    if (actualReduction <= 0) {
      continue;
    }

    replacements.push({ entryId: candidate.entryId, message: truncatedMessage });
    remainingReduction -= actualReduction;
  }

  return replacements;
}

function applyToolResultReplacementsToBranch(params: {
  branch: Array<{ id: string; type: string; message?: AgentMessage }>;
  replacements: Array<{ entryId: string; message: AgentMessage }>;
}): Array<{ id: string; type: string; message?: AgentMessage }> {
  if (params.replacements.length === 0) {
    return params.branch;
  }

  const replacementsById = new Map(
    params.replacements.map((replacement) => [replacement.entryId, replacement.message]),
  );

  return params.branch.map((entry) => {
    if (entry.type !== "message") {
      return entry;
    }
    const replacement = replacementsById.get(entry.id);
    if (!replacement) {
      return entry;
    }
    return { ...entry, message: replacement };
  });
}

export function estimateToolResultReductionPotential(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): ToolResultReductionPotential {
  const { messages, contextWindowTokens } = params;
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens);

  let toolResultCount = 0;
  let totalToolResultChars = 0;
  let oversizedCount = 0;
  let oversizedReducibleChars = 0;
  const individuallyTrimmedMessages = messages.slice();

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if ((msg as { role?: string }).role !== "toolResult") {
      continue;
    }
    const textLength = getToolResultTextLength(msg);
    if (textLength <= 0) {
      continue;
    }
    toolResultCount += 1;
    totalToolResultChars += textLength;
    if (textLength <= maxChars) {
      continue;
    }
    oversizedCount += 1;
    const truncatedMessage = truncateToolResultMessage(msg, maxChars, {
      minKeepChars: RECOVERY_MIN_KEEP_CHARS,
    });
    individuallyTrimmedMessages[index] = truncatedMessage;
    oversizedReducibleChars += Math.max(0, textLength - getToolResultTextLength(truncatedMessage));
  }

  const aggregateReplacements = buildAggregateToolResultReplacements({
    branch: individuallyTrimmedMessages.map((message, index) => ({
      id: `message-${index}`,
      type: "message",
      message,
    })),
    aggregateBudgetChars,
    minKeepChars: RECOVERY_MIN_KEEP_CHARS,
  });
  const individuallyTrimmedBranch = individuallyTrimmedMessages.map((message, index) => ({
    id: `message-${index}`,
    type: "message",
    message,
  }));
  const aggregateReducibleChars = aggregateReplacements.reduce((sum, replacement) => {
    const match = individuallyTrimmedBranch.find((entry) => entry.id === replacement.entryId);
    const originalLength =
      match && match.message
        ? getToolResultTextLength(match.message)
        : getToolResultTextLength(replacement.message);
    const newLength = getToolResultTextLength(replacement.message);
    return sum + Math.max(0, originalLength - newLength);
  }, 0);
  const maxReducibleChars = oversizedReducibleChars + aggregateReducibleChars;

  return {
    maxChars,
    aggregateBudgetChars,
    toolResultCount,
    totalToolResultChars,
    oversizedCount,
    oversizedReducibleChars,
    aggregateReducibleChars,
    maxReducibleChars,
  };
}

function truncateOversizedToolResultsInExistingSessionManager(params: {
  sessionManager: SessionManager;
  contextWindowTokens: number;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
}): { truncated: boolean; truncatedCount: number; reason?: string } {
  const { sessionManager, contextWindowTokens } = params;
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens);
  const branch = sessionManager.getBranch();

  if (branch.length === 0) {
    return { truncated: false, truncatedCount: 0, reason: "empty session" };
  }

  const oversizedIndices: number[] = [];
  for (let i = 0; i < branch.length; i += 1) {
    const entry = branch[i];
    if (entry.type !== "message") {
      continue;
    }
    const msg = entry.message;
    if ((msg as { role?: string }).role !== "toolResult") {
      continue;
    }
    if (getToolResultTextLength(msg) > maxChars) {
      oversizedIndices.push(i);
    }
  }

  const oversizedReplacements = oversizedIndices.flatMap((index) => {
    const entry = branch[index];
    if (!entry || entry.type !== "message") {
      return [];
    }
    return [
      {
        entryId: entry.id,
        message: truncateToolResultMessage(entry.message, maxChars, {
          minKeepChars: RECOVERY_MIN_KEEP_CHARS,
        }),
      },
    ];
  });

  const oversizedTrimmedBranch = applyToolResultReplacementsToBranch({
    branch: branch as Array<{ id: string; type: string; message?: AgentMessage }>,
    replacements: oversizedReplacements,
  });
  const aggregateReplacements = buildAggregateToolResultReplacements({
    branch: oversizedTrimmedBranch,
    aggregateBudgetChars,
    minKeepChars: RECOVERY_MIN_KEEP_CHARS,
  });
  const replacements = [...oversizedReplacements];
  const replacementIndexById = new Map(replacements.map((replacement) => [replacement.entryId, replacement]));
  for (const replacement of aggregateReplacements) {
    replacementIndexById.set(replacement.entryId, replacement);
  }
  const mergedReplacements = Array.from(replacementIndexById.values());

  if (mergedReplacements.length === 0) {
    return {
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized or aggregate tool results",
    };
  }

  const rewriteResult = rewriteTranscriptEntriesInSessionManager({
    sessionManager,
    replacements: mergedReplacements,
  });
  if (rewriteResult.changed && params.sessionFile) {
    emitSessionTranscriptUpdate(params.sessionFile);
  }

  const truncatedKinds = [
    oversizedReplacements.length > 0 ? "oversized" : "",
    aggregateReplacements.length > 0 ? "aggregate" : "",
  ]
    .filter(Boolean)
    .join("+");

  log.info(
    `[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} ${truncatedKinds || "tool"} tool result(s) in session ` +
      `(contextWindow=${contextWindowTokens} maxChars=${maxChars} aggregateBudgetChars=${aggregateBudgetChars}) ` +
      `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
  );

  return {
    truncated: rewriteResult.changed,
    truncatedCount: rewriteResult.rewrittenEntries,
    reason: rewriteResult.reason,
  };
}

export function truncateOversizedToolResultsInSessionManager(params: {
  sessionManager: SessionManager;
  contextWindowTokens: number;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
}): { truncated: boolean; truncatedCount: number; reason?: string } {
  try {
    return truncateOversizedToolResultsInExistingSessionManager(params);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}

export async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  const { sessionFile, contextWindowTokens } = params;
  let sessionLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;

  try {
    sessionLock = await acquireSessionWriteLock({ sessionFile });
    const sessionManager = SessionManager.open(sessionFile);
    return truncateOversizedToolResultsInExistingSessionManager({
      sessionManager,
      contextWindowTokens,
      sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  } finally {
    await sessionLock?.release();
  }
}

/**
 * Check if a tool result message exceeds the size limit for a given context window.
 */
export function isOversizedToolResult(msg: AgentMessage, contextWindowTokens: number): boolean {
  if ((msg as { role?: string }).role !== "toolResult") {
    return false;
  }
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  return getToolResultTextLength(msg) > maxChars;
}

export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): boolean {
  const estimate = estimateToolResultReductionPotential(params);
  return estimate.oversizedCount > 0 || estimate.aggregateReducibleChars > 0;
}
