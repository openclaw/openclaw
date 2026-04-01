/**
 * Context compression layers inspired by Claude Code's multi-layer approach.
 *
 * These layers run BEFORE the existing auto-compaction (summarization) to
 * reduce token usage cheaply without burning API calls on summaries.
 *
 * Layer 1: applyToolResultBudget — truncate oversized tool results
 * Layer 2: snipCompact — discard old history tail
 * Layer 3: microCompact — deduplicate redundant tool results
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { estimateMessagesTokens } from "./compaction.js";

const log = createSubsystemLogger("context-layers");

// ─── Layer 1: ToolResultBudget ───────────────────────────────────────────

/** Default max chars for a single tool result. ~50K chars ≈ 12K tokens. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 50_000;

/** Minimum chars to always preserve (don't truncate tiny results). */
const TOOL_RESULT_MIN_CHARS = 500;

export type ToolResultBudgetOptions = {
  maxChars?: number;
};

/**
 * Truncate oversized tool results to prevent them from consuming too much context.
 *
 * Tool results (especially shell output, file reads) can be enormous.
 * This layer caps each result at maxChars, appending a truncation notice.
 */
export function applyToolResultBudget(
  messages: AgentMessage[],
  options?: ToolResultBudgetOptions,
): { messages: AgentMessage[]; truncated: number; tokensFreed: number } {
  const maxChars = options?.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  let truncated = 0;
  let tokensFreed = 0;

  const result = messages.map((msg) => {
    if (!isToolResultMessage(msg)) return msg;
    const content = extractContentString(msg);
    if (!content || content.length <= maxChars) return msg;

    const omitted = content.length - maxChars;
    tokensFreed += Math.ceil(omitted / 4);
    truncated++;

    return setContentString(
      msg,
      content.slice(0, maxChars) +
        `\n\n[... truncated: ${omitted.toLocaleString()} chars omitted (original: ${content.length.toLocaleString()} chars). ` +
        `Use more specific queries to get targeted results instead of full output.]`,
    );
  });

  if (truncated > 0) {
    log.info(
      `ToolResultBudget: truncated ${truncated} results, freed ~${tokensFreed.toLocaleString()} tokens`,
    );
  }

  return { messages: result, truncated, tokensFreed };
}

// ─── Layer 2: snipCompact ────────────────────────────────────────────────

export type SnipCompactOptions = {
  /** Fraction of messages to keep (0.0-1.0). Default 0.6 = keep recent 60%. */
  keepRecentRatio?: number;
  /** Minimum number of messages to always keep. Default 4. */
  minKeep?: number;
  /** Token threshold to trigger snip. Default 0 (always apply if ratio < 1.0). */
  tokenThreshold?: number;
};

/**
 * Discard the oldest fraction of conversation history.
 *
 * Unlike auto-compaction (which summarizes), snip just drops old messages.
 * Fast, zero API cost, but loses context. Best used as a pre-pass before
 * auto-compaction to reduce the amount of text the summarizer needs to process.
 */
export function snipCompact(
  messages: AgentMessage[],
  options?: SnipCompactOptions,
): { messages: AgentMessage[]; snipped: number; tokensFreed: number } {
  const keepRatio = Math.max(0.1, Math.min(1.0, options?.keepRecentRatio ?? 0.6));
  const minKeep = Math.max(2, options?.minKeep ?? 4);

  if (keepRatio >= 1.0 || messages.length <= minKeep) {
    return { messages, snipped: 0, tokensFreed: 0 };
  }

  const keepCount = Math.max(minKeep, Math.floor(messages.length * keepRatio));
  const snipCount = messages.length - keepCount;

  if (snipCount <= 0) {
    return { messages, snipped: 0, tokensFreed: 0 };
  }

  // Preserve system messages at the beginning
  const systemMessages: AgentMessage[] = [];
  let firstNonSystem = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "system") {
      systemMessages.push(messages[i]);
      firstNonSystem = i + 1;
    } else {
      break;
    }
  }

  // Only snip non-system messages
  const nonSystemMessages = messages.slice(firstNonSystem);
  if (nonSystemMessages.length <= minKeep) {
    return { messages, snipped: 0, tokensFreed: 0 };
  }

  const nonSystemKeep = Math.max(minKeep, Math.floor(nonSystemMessages.length * keepRatio));
  const kept = nonSystemMessages.slice(nonSystemMessages.length - nonSystemKeep);
  const snipped = nonSystemMessages.length - kept.length;

  const beforeTokens = estimateMessagesTokens(nonSystemMessages);
  const afterTokens = estimateMessagesTokens(kept);
  const tokensFreed = beforeTokens - afterTokens;

  // Build result: system messages + a summary marker + kept messages
  const summaryMessage: AgentMessage = {
    role: "system",
    content: `[Context snipped: ${snipped} older messages removed to manage context window. ${kept.length} recent messages preserved.]`,
    timestamp: Date.now(),
  };

  const result = [...systemMessages, summaryMessage, ...kept];

  log.info(
    `snipCompact: removed ${snipped} messages, freed ~${tokensFreed.toLocaleString()} tokens`,
  );

  return { messages: result, snipped, tokensFreed };
}

// ─── Layer 3: microCompact ───────────────────────────────────────────────

export type MicroCompactOptions = {
  /** Tool names to always preserve (never deduplicate). */
  preserveToolNames?: string[];
};

/**
 * Remove redundant tool results where the same tool was called with the same
 * arguments multiple times. Keeps only the LAST result for each unique call.
 *
 * Example: If the agent reads the same file 3 times, only the last read result
 * is kept. The assistant messages referencing the removed results are updated
 * to point to the surviving one.
 */
export function microCompact(
  messages: AgentMessage[],
  options?: MicroCompactOptions,
): { messages: AgentMessage[]; removed: number; tokensFreed: number } {
  const preserveSet = new Set(
    (options?.preserveToolNames ?? []).map((n) => n.toLowerCase()),
  );

  // Phase 1: Identify all tool_use → tool_result pairs and their content hashes
  type ToolCall = {
    toolUseIndex: number;
    toolResultIndex: number;
    callKey: string; // toolName + hash(input)
    contentHash: string;
  };

  const toolCalls: ToolCall[] = [];
  const toolUseById = new Map<string, { index: number; name: string; inputHash: string }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    // Track tool_use blocks
    if (msg.role === "assistant") {
      const blocks = getContentBlocks(msg);
      for (const block of blocks) {
        if (block?.type === "tool_use" && block.id) {
          const inputStr = JSON.stringify(block.input ?? {});
          toolUseById.set(block.id, {
            index: i,
            name: block.name ?? "unknown",
            inputHash: simpleHash(inputStr),
          });
        }
      }
    }

    // Track tool_result blocks
    if (isToolResultMessage(msg)) {
      const toolUseId = extractToolUseId(msg);
      if (toolUseId && toolUseById.has(toolUseId)) {
        const toolUse = toolUseById.get(toolUseId)!;
        const content = extractContentString(msg) ?? "";
        toolCalls.push({
          toolUseIndex: toolUse.index,
          toolResultIndex: i,
          callKey: `${toolUse.name}:${toolUse.inputHash}`,
          contentHash: simpleHash(content),
        });
      }
    }
  }

  // Phase 2: For each callKey, keep only the LAST occurrence
  const lastOccurrence = new Map<string, number>();
  for (const call of toolCalls) {
    lastOccurrence.set(call.callKey, call.toolResultIndex);
  }

  // Phase 3: Mark indices to remove
  const toRemove = new Set<number>();
  for (const call of toolCalls) {
    if (
      call.toolResultIndex !== lastOccurrence.get(call.callKey) &&
      !preserveSet.has(call.callKey.split(":")[0].toLowerCase())
    ) {
      toRemove.add(call.toolResultIndex);
    }
  }

  if (toRemove.size === 0) {
    return { messages, removed: 0, tokensFreed: 0 };
  }

  // Phase 4: Calculate freed tokens and build result
  let tokensFreed = 0;
  const result: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (toRemove.has(i)) {
      tokensFreed += Math.ceil((extractContentString(messages[i])?.length ?? 0) / 4);
    } else {
      result.push(messages[i]);
    }
  }

  log.info(
    `microCompact: removed ${toRemove.size} redundant tool results, freed ~${tokensFreed.toLocaleString()} tokens`,
  );

  return { messages: result, removed: toRemove.size, tokensFreed };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isToolResultMessage(msg: AgentMessage): boolean {
  return msg.role === "tool" || msg.role === "toolResult";
}

function extractContentString(msg: AgentMessage): string | undefined {
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => b?.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return undefined;
}

function setContentString(msg: AgentMessage, content: string): AgentMessage {
  return { ...msg, content } as AgentMessage;
}

function extractToolUseId(msg: AgentMessage): string | undefined {
  const rec = msg as Record<string, unknown>;
  if (typeof rec.tool_use_id === "string") return rec.tool_use_id;
  if (typeof rec.toolUseId === "string") return rec.toolUseId;
  return undefined;
}

function getContentBlocks(msg: AgentMessage): Array<Record<string, unknown>> {
  const content = (msg as Record<string, unknown>).content;
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
  return [];
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
