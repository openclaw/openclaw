import type { CachedMessages, ConversationTurn } from "./types.js";

/** Time-to-live for cached entries (30 minutes). */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Maximum number of sessions to track simultaneously. */
const MAX_CACHE_SIZE = 100;

/**
 * In-memory cache of recent conversation turns, keyed by sessionKey.
 *
 * Populated by the `llm_input` hook (which fires before each LLM invocation)
 * and read by the `before_tool_call` hook.
 */
const cache = new Map<string, CachedMessages>();

/**
 * Update the cache with the latest conversation turns for a session.
 *
 * Extracts user→assistant turn pairs from the raw historyMessages array,
 * then appends the current prompt (which is NOT included in historyMessages)
 * as the final turn (without an assistant reply yet).
 * Keeps only the last `maxTurns` entries.
 *
 * **Why include assistant messages?**
 * Without assistant context, the guardian cannot understand confirmations.
 * Example: assistant asks "Delete these files?" → user says "Yes" →
 * the guardian only sees "Yes" with no context and blocks the deletion.
 * By pairing user messages with the preceding assistant reply, the guardian
 * can reason about what the user confirmed.
 */
export function updateCache(
  sessionKey: string,
  historyMessages: unknown[],
  currentPrompt: string | undefined,
  maxTurns: number,
): void {
  const turns = extractConversationTurns(historyMessages);

  // Append the current prompt — this is the LATEST user message that
  // triggered the current LLM turn. It is NOT part of historyMessages.
  if (currentPrompt && currentPrompt.trim() && !currentPrompt.startsWith("/")) {
    const cleanedPrompt = stripChannelMetadata(currentPrompt.trim());
    if (cleanedPrompt && !cleanedPrompt.startsWith("/")) {
      turns.push({ user: cleanedPrompt });
    }
  }

  // Keep only the most recent N turns
  const recent = turns.slice(-maxTurns);

  cache.set(sessionKey, {
    turns: recent,
    updatedAt: Date.now(),
  });

  // Evict expired entries and enforce size limit
  pruneCache();
}

/**
 * Retrieve the cached conversation turns for a session.
 * Returns an empty array if no turns are cached or the entry has expired.
 */
export function getRecentTurns(sessionKey: string): ConversationTurn[] {
  const entry = cache.get(sessionKey);
  if (!entry) return [];

  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
    cache.delete(sessionKey);
    return [];
  }

  return entry.turns;
}

/**
 * Clear the entire cache. Primarily useful for testing.
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Get the current cache size. Useful for diagnostics.
 */
export function cacheSize(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Prune expired entries and enforce the max cache size (LRU by insertion order). */
function pruneCache(): void {
  const now = Date.now();

  // Remove expired entries
  for (const [key, entry] of cache) {
    if (now - entry.updatedAt > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }

  // Enforce size limit (Map preserves insertion order — delete oldest)
  while (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
    } else {
      break;
    }
  }
}

/**
 * Extract conversation turns from the historyMessages array.
 *
 * Walks through messages in order, pairing each user message with ALL
 * assistant replies that preceded it (since the previous user message).
 * This gives the guardian the full conversational context needed to
 * understand confirmations.
 *
 * An assistant may produce multiple messages in one turn (e.g. text reply,
 * tool call, tool result, then another text reply). All assistant messages
 * between two user messages are concatenated into a single string.
 *
 * Message flow: [assistant₁a, assistant₁b, user₁, assistant₂, user₂, ...]
 * → turns: [{user: user₁, assistant: "assistant₁a\nassistant₁b"}, {user: user₂, assistant: assistant₂}]
 */
export function extractConversationTurns(historyMessages: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const assistantParts: string[] = [];

  for (const msg of historyMessages) {
    if (!isMessageLike(msg)) continue;

    if (msg.role === "assistant") {
      const text = extractAssistantText(msg.content);
      if (text) {
        assistantParts.push(text);
      }
      continue;
    }

    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      if (!text || text.startsWith("/")) {
        // Skip slash commands — they're control messages, not user intent
        continue;
      }

      // Merge all assistant messages since the last user message
      const mergedAssistant = mergeAssistantParts(assistantParts);
      turns.push({
        user: text,
        assistant: mergedAssistant,
      });
      // Reset — start collecting assistant messages for the next turn
      assistantParts.length = 0;
    }
  }

  return turns;
}

/** Type guard for objects that look like { role: string, content: unknown }. */
function isMessageLike(msg: unknown): msg is { role: string; content: unknown } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "role" in msg &&
    typeof (msg as Record<string, unknown>).role === "string" &&
    "content" in msg
  );
}

/**
 * Extract text content from a user message's content field.
 * Handles both string content and array-of-blocks content (e.g., multimodal messages).
 * Strips channel metadata blocks (e.g., Telegram's "Conversation info") that are
 * prepended by OpenClaw channel plugins — these pollute the guardian's context.
 */
function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return stripChannelMetadata(content.trim()) || undefined;
  }

  if (Array.isArray(content)) {
    // Find the first text block in a multimodal message
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        const text = stripChannelMetadata(
          ((block as Record<string, unknown>).text as string).trim(),
        );
        if (text) return text;
      }
    }
  }

  return undefined;
}

/**
 * Merge multiple assistant text parts into a single string.
 *
 * An assistant turn may span multiple messages (e.g. text → tool call →
 * tool result → text). We concatenate all text parts so the guardian
 * can see the full assistant reply for context.
 */
function mergeAssistantParts(parts: string[]): string | undefined {
  if (parts.length === 0) return undefined;
  const merged = parts.join("\n").trim();
  if (!merged) return undefined;
  return merged;
}

/**
 * Extract raw text from an assistant message's content field.
 */
function extractAssistantText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }

  if (Array.isArray(content)) {
    // Collect text blocks from multimodal assistant messages
    const textParts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        textParts.push(((block as Record<string, unknown>).text as string).trim());
      }
    }
    const text = textParts.join("\n").trim();
    return text || undefined;
  }

  return undefined;
}

/**
 * Strip channel-injected metadata blocks from user message text.
 *
 * OpenClaw channel plugins (Telegram, Slack, etc.) prepend metadata like:
 *
 *   Conversation info (untrusted metadata):
 *   ```json
 *   { "message_id": "1778", "sender_id": "..." }
 *   ```
 *
 *   <actual user message>
 *
 * The guardian only needs the actual user message, not the metadata.
 * This function strips all such blocks.
 */
function stripChannelMetadata(text: string): string {
  // Pattern: "Conversation info (untrusted metadata):" followed by a fenced code block
  // The code block may use ```json or just ```
  // We match from the label through the closing ```, then trim what remains
  const metadataPattern = /Conversation info\s*\(untrusted metadata\)\s*:\s*```[\s\S]*?```/gi;

  let cleaned = text.replace(metadataPattern, "");

  // Collapse runs of 3+ newlines into 2 (preserve paragraph breaks)
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}
