/**
 * Conversation history serialization for the Claude Agent SDK runner.
 *
 * Since the SDK is stateless (each query() starts fresh), prior conversation
 * turns must be serialized into the prompt to provide multi-turn context.
 * This module converts structured conversation history into a text block
 * that can be prepended to the system prompt or user message.
 */

import type { SdkConversationTurn } from "./sdk-runner.types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max characters of serialized history to include (prevents context overflow). */
const DEFAULT_MAX_HISTORY_CHARS = 60_000;

/** Max number of turns to include (most recent). */
const DEFAULT_MAX_HISTORY_TURNS = 20;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export type SerializeHistoryOptions = {
  /** Max characters of serialized history (default: 60000). */
  maxChars?: number;
  /** Max number of turns to include (default: 20). */
  maxTurns?: number;
};

/**
 * Serialize conversation history into a text block suitable for injection
 * into a system prompt or user message.
 *
 * Returns an empty string if no history is provided.
 *
 * Format:
 * ```
 * <conversation-history>
 * [User] (2025-01-26T10:00:00Z):
 * Hello, how are you?
 *
 * [Assistant] (2025-01-26T10:00:05Z):
 * I'm doing well! How can I help?
 * </conversation-history>
 * ```
 */
export function serializeConversationHistory(
  turns: SdkConversationTurn[] | undefined,
  options?: SerializeHistoryOptions,
): string {
  if (!turns || turns.length === 0) return "";

  const maxChars = options?.maxChars ?? DEFAULT_MAX_HISTORY_CHARS;
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_HISTORY_TURNS;

  // Take the most recent turns.
  const recentTurns = turns.length > maxTurns ? turns.slice(-maxTurns) : turns;

  const parts: string[] = [];
  let totalChars = 0;

  // Build from oldest to newest, but respect char limit.
  for (const turn of recentTurns) {
    const label = turn.role === "user" ? "User" : "Assistant";
    const timestamp = turn.timestamp ? ` (${turn.timestamp})` : "";
    const header = `[${label}]${timestamp}:`;
    const block = `${header}\n${turn.content.trim()}`;

    if (totalChars + block.length + 2 > maxChars) {
      // If we haven't added anything yet, truncate this block.
      if (parts.length === 0) {
        const truncated = block.slice(0, maxChars - 20) + "\n[...truncated]";
        parts.push(truncated);
      }
      break;
    }

    parts.push(block);
    totalChars += block.length + 2; // +2 for \n\n separator
  }

  if (parts.length === 0) return "";

  const truncatedNote =
    turns.length > recentTurns.length
      ? `\n(${turns.length - recentTurns.length} earlier turns omitted)\n\n`
      : "";

  return `<conversation-history>${truncatedNote}\n${parts.join("\n\n")}\n</conversation-history>`;
}

/**
 * Build a system prompt suffix that includes conversation history context.
 *
 * This is injected into the system prompt so the agent is aware of prior
 * conversation turns. The instruction tells the agent to treat these as
 * prior context (not new instructions).
 */
export function buildHistorySystemPromptSuffix(
  turns: SdkConversationTurn[] | undefined,
  options?: SerializeHistoryOptions,
): string {
  const serialized = serializeConversationHistory(turns, options);
  if (!serialized) return "";

  return (
    "\n\n## Prior Conversation Context\n\n" +
    "The following is the conversation history from prior turns. " +
    "Use this context to maintain continuity but do not re-execute " +
    "previously completed actions.\n\n" +
    serialized
  );
}
