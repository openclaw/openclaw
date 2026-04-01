import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { estimateTextTokensApprox } from "../token-approximation.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { log } from "./logger.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

/**
 * Maximum share of the context window a single tool result should occupy.
 * This is intentionally conservative – a single tool result should not
 * consume more than 30% of the context window even without other messages.
 */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/**
 * Hard character limit for a single tool result text block.
 * Even for the largest context windows (~2M tokens), a single tool result
 * should not exceed ~400K characters (~100K tokens).
 * This acts as a safety net when we don't know the context window size.
 */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;
export const DEFAULT_TOOL_RESULT_MAX_TOKENS = 2_000;
const TOOL_RESULT_HEAD_TOKENS = 500;
const TOOL_RESULT_TAIL_TOKENS = 500;
const MIN_TOOL_RESULT_BODY_TOKENS = 64;
const TOKEN_TRUNCATION_OMISSION_MARKER =
  "\n\n[... middle content omitted — showing head and tail ...]\n\n";

function resolvePositiveInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Resolve the configured single-tool-result budget. The configured max acts as
 * a hard ceiling, but very small context windows still clamp below it so one
 * tool result cannot dominate the prompt.
 */
export function resolveToolResultMaxTokens(
  contextWindowTokens: number,
  cfg?: OpenClawConfig,
  override?: number,
): number {
  const configured =
    resolvePositiveInt(override) ??
    resolvePositiveInt(cfg?.agents?.defaults?.tokenLimits?.toolResultMax) ??
    DEFAULT_TOOL_RESULT_MAX_TOKENS;
  const contextShareCap = Math.max(256, Math.floor(Math.max(1, contextWindowTokens) * 0.5));
  return Math.max(MIN_TOOL_RESULT_BODY_TOKENS, Math.min(configured, contextShareCap));
}

function buildTokenTruncationNotice(originalTokens: number, truncatedTokens: number): string {
  return `[Truncated: original ${originalTokens} tokens → ${truncatedTokens} tokens. Full output available via tool recall.]`;
}

/**
 * Minimum characters to keep when truncating.
 * We always keep at least the first portion so the model understands
 * what was in the content.
 */
const MIN_KEEP_CHARS = 2_000;

/**
 * Suffix appended to truncated tool results.
 */
const TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated — original was too large for the model's context window. " +
  "The content above is a partial view. If you need more, request specific sections or use " +
  "offset/limit parameters to read smaller chunks.]";

type ToolResultTruncationOptions = {
  suffix?: string;
  minKeepChars?: number;
};

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
  const suffix = options.suffix ?? TRUNCATION_SUFFIX;
  const minKeepChars = options.minKeepChars ?? MIN_KEEP_CHARS;
  if (text.length <= maxChars) {
    return text;
  }
  const budget = Math.max(minKeepChars, maxChars - suffix.length);

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

      return text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart) + suffix;
    }
  }

  // Default: keep the beginning
  let cutPoint = budget;
  const lastNewline = text.lastIndexOf("\n", budget);
  if (lastNewline > budget * 0.8) {
    cutPoint = lastNewline;
  }
  return text.slice(0, cutPoint) + suffix;
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
  return Math.min(maxChars, HARD_MAX_TOOL_RESULT_CHARS);
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

export function getToolResultTextTokenCount(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let totalTokens = 0;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      continue;
    }
    const text = (block as TextContent).text;
    if (typeof text === "string") {
      totalTokens += estimateTextTokensApprox(text);
    }
  }
  return totalTokens;
}

function takeHeadByApproxTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) {
    return "";
  }
  if (estimateTextTokensApprox(text) <= maxTokens) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (estimateTextTokensApprox(candidate) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const best = text.slice(0, low);
  const newline = best.lastIndexOf("\n");
  return newline > best.length * 0.7 ? best.slice(0, newline) : best;
}

function takeTailByApproxTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) {
    return "";
  }
  if (estimateTextTokensApprox(text) <= maxTokens) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(text.length - mid);
    if (estimateTextTokensApprox(candidate) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const best = text.slice(text.length - low);
  const newline = best.indexOf("\n");
  return newline !== -1 && newline < best.length * 0.3 ? best.slice(newline + 1) : best;
}

function resolveHeadTailTokenBudgets(maxTokens: number, noticeBudgetTokens: number) {
  const bodyBudget = Math.max(MIN_TOOL_RESULT_BODY_TOKENS, maxTokens - noticeBudgetTokens);
  if (bodyBudget >= TOOL_RESULT_HEAD_TOKENS + TOOL_RESULT_TAIL_TOKENS) {
    return {
      headTokens: TOOL_RESULT_HEAD_TOKENS,
      tailTokens: TOOL_RESULT_TAIL_TOKENS,
    };
  }
  const headTokens = Math.max(32, Math.floor(bodyBudget / 2));
  const tailTokens = Math.max(32, bodyBudget - headTokens);
  return { headTokens, tailTokens };
}

/**
 * Token-aware truncation used for prompt context shaping. It preserves the
 * first and last ~500 tokens by default, then prepends a recall hint so the
 * agent knows more output exists off-context.
 */
export function truncateToolResultTextToTokens(text: string, maxTokens: number): string {
  const resolvedMaxTokens = Math.max(MIN_TOOL_RESULT_BODY_TOKENS, Math.floor(maxTokens));
  const originalTokens = estimateTextTokensApprox(text);
  if (originalTokens <= resolvedMaxTokens) {
    return text;
  }

  let noticeBudgetTokens = estimateTextTokensApprox(
    buildTokenTruncationNotice(originalTokens, resolvedMaxTokens) +
      TOKEN_TRUNCATION_OMISSION_MARKER,
  );
  let { headTokens, tailTokens } = resolveHeadTailTokenBudgets(resolvedMaxTokens, noticeBudgetTokens);
  let head = takeHeadByApproxTokens(text, headTokens);
  let tail = takeTailByApproxTokens(text, tailTokens);
  let body = `${head}${TOKEN_TRUNCATION_OMISSION_MARKER}${tail}`;
  let truncatedTokens = estimateTextTokensApprox(body);
  let truncatedText =
    `${buildTokenTruncationNotice(originalTokens, truncatedTokens)}\n\n${body}`.trim();
  let totalTokens = estimateTextTokensApprox(truncatedText);
  let attempts = 0;

  while (totalTokens > resolvedMaxTokens && attempts < 8) {
    attempts += 1;
    noticeBudgetTokens = estimateTextTokensApprox(
      buildTokenTruncationNotice(originalTokens, totalTokens) + TOKEN_TRUNCATION_OMISSION_MARKER,
    );
    ({ headTokens, tailTokens } = resolveHeadTailTokenBudgets(resolvedMaxTokens, noticeBudgetTokens));
    const shrinkBy = Math.max(16, totalTokens - resolvedMaxTokens);
    head = takeHeadByApproxTokens(text, Math.max(32, headTokens - Math.ceil(shrinkBy / 2)));
    tail = takeTailByApproxTokens(text, Math.max(32, tailTokens - Math.floor(shrinkBy / 2)));
    body = `${head}${TOKEN_TRUNCATION_OMISSION_MARKER}${tail}`;
    truncatedTokens = estimateTextTokensApprox(body);
    truncatedText = `${buildTokenTruncationNotice(originalTokens, truncatedTokens)}\n\n${body}`.trim();
    totalTokens = estimateTextTokensApprox(truncatedText);
  }

  return truncatedText;
}

export function truncateToolResultMessageToTokens(
  msg: AgentMessage,
  maxTokens: number,
): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }
  const totalTokens = getToolResultTextTokenCount(msg);
  if (totalTokens <= maxTokens) {
    return msg;
  }

  const textParts: string[] = [];
  const nonTextBlocks: unknown[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as TextContent).text;
      if (typeof text === "string") {
        textParts.push(text);
      }
      continue;
    }
    nonTextBlocks.push(block);
  }

  const truncatedText = truncateToolResultTextToTokens(textParts.join("\n"), maxTokens);
  const nextContent = [{ type: "text", text: truncatedText }, ...nonTextBlocks];
  return { ...msg, content: nextContent } as AgentMessage;
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
  const suffix = options.suffix ?? TRUNCATION_SUFFIX;
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
    const blockBudget = Math.max(minKeepChars + suffix.length, Math.floor(maxChars * blockShare));
    return {
      ...textBlock,
      text: truncateToolResultText(textBlock.text, blockBudget, { suffix, minKeepChars }),
    };
  });

  return { ...msg, content: newContent } as AgentMessage;
}

/**
 * Find oversized tool result entries in a session and truncate them.
 *
 * This operates on the session file by:
 * 1. Opening the session manager
 * 2. Walking the current branch to find oversized tool results
 * 3. Branching from before the first oversized tool result
 * 4. Re-appending all entries from that point with truncated tool results
 *
 * @returns Object indicating whether any truncation was performed
 */
export async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  toolResultMaxTokens?: number;
  cfg?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  const { sessionFile, contextWindowTokens } = params;
  const maxTokens = resolveToolResultMaxTokens(
    contextWindowTokens,
    params.cfg,
    params.toolResultMaxTokens,
  );
  let sessionLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;

  try {
    sessionLock = await acquireSessionWriteLock({ sessionFile });
    const sessionManager = SessionManager.open(sessionFile);
    const branch = sessionManager.getBranch();

    if (branch.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "empty session" };
    }

    // Find oversized tool result entries and their indices in the branch
    const oversizedIndices: number[] = [];
    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      if (entry.type !== "message") {
        continue;
      }
      const msg = entry.message;
      if ((msg as { role?: string }).role !== "toolResult") {
        continue;
      }
      const tokenCount = getToolResultTextTokenCount(msg);
      if (tokenCount > maxTokens) {
        oversizedIndices.push(i);
        log.info(
          `[tool-result-truncation] Found oversized tool result: ` +
            `entry=${entry.id} tokens=${tokenCount} maxTokens=${maxTokens} ` +
            `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
        );
      }
    }

    if (oversizedIndices.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "no oversized tool results" };
    }

    const replacements = oversizedIndices.flatMap((index) => {
      const entry = branch[index];
      if (!entry || entry.type !== "message") {
        return [];
      }
      const message = truncateToolResultMessageToTokens(entry.message, maxTokens);
      const newTokens = getToolResultTextTokenCount(message);
      log.info(
        `[tool-result-truncation] Truncated tool result: ` +
          `originalEntry=${entry.id} newTokens=${newTokens} ` +
          `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
      );
      return [{ entryId: entry.id, message }];
    });

    const rewriteResult = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements,
    });
    if (rewriteResult.changed) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    log.info(
      `[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session ` +
        `(contextWindow=${contextWindowTokens} maxTokens=${maxTokens}) ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );

    return {
      truncated: rewriteResult.changed,
      truncatedCount: rewriteResult.rewrittenEntries,
      reason: rewriteResult.reason,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  } finally {
    await sessionLock?.release();
  }
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
  options: { toolResultMaxTokens?: number; cfg?: OpenClawConfig } = {},
): { messages: AgentMessage[]; truncatedCount: number } {
  const maxTokens = resolveToolResultMaxTokens(
    contextWindowTokens,
    options.cfg,
    options.toolResultMaxTokens,
  );
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if ((msg as { role?: string }).role !== "toolResult") {
      return msg;
    }
    const tokenCount = getToolResultTextTokenCount(msg);
    if (tokenCount <= maxTokens) {
      return msg;
    }
    truncatedCount++;
    return truncateToolResultMessageToTokens(msg, maxTokens);
  });

  return { messages: result, truncatedCount };
}

/**
 * Check if a tool result message exceeds the size limit for a given context window.
 */
export function isOversizedToolResult(
  msg: AgentMessage,
  contextWindowTokens: number,
  options: { toolResultMaxTokens?: number; cfg?: OpenClawConfig } = {},
): boolean {
  if ((msg as { role?: string }).role !== "toolResult") {
    return false;
  }
  const maxTokens = resolveToolResultMaxTokens(
    contextWindowTokens,
    options.cfg,
    options.toolResultMaxTokens,
  );
  return getToolResultTextTokenCount(msg) > maxTokens;
}

/**
 * Estimate whether the session likely has oversized tool results that caused
 * a context overflow. Used as a heuristic to decide whether to attempt
 * tool result truncation before giving up.
 */
export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  toolResultMaxTokens?: number;
  cfg?: OpenClawConfig;
}): boolean {
  const { messages, contextWindowTokens } = params;
  const maxTokens = resolveToolResultMaxTokens(
    contextWindowTokens,
    params.cfg,
    params.toolResultMaxTokens,
  );

  for (const msg of messages) {
    if ((msg as { role?: string }).role !== "toolResult") {
      continue;
    }
    const tokenCount = getToolResultTextTokenCount(msg);
    if (tokenCount > maxTokens) {
      return true;
    }
  }

  return false;
}
