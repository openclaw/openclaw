import type { CachedMessages, ConversationTurn } from "./types.js";

/** Time-to-live for cached entries (30 minutes). */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Maximum number of sessions to track simultaneously. */
const MAX_CACHE_SIZE = 100;

/**
 * In-memory cache of conversation state, keyed by sessionKey.
 *
 * Populated by the `llm_input` hook (which fires before each LLM invocation)
 * and read by the `before_tool_call` hook.
 *
 * The cache stores a **live reference** to the session's message array,
 * not a snapshot. This means tool results added during the agent loop
 * (after `llm_input` fires) are visible when `getRecentTurns()` lazily
 * re-extracts turns at `before_tool_call` time.
 */
const cache = new Map<string, CachedMessages>();

/**
 * Update the cache with a live reference to the session's message array.
 *
 * Does NOT eagerly extract turns — extraction is deferred to
 * `getRecentTurns()` so that tool results added during the agent loop
 * are included.
 *
 * @returns The total number of turns in the history (for summary decisions).
 */
export function updateCache(
  sessionKey: string,
  historyMessages: unknown[],
  currentPrompt: string | undefined,
  maxRecentTurns: number,
  contextTools: Set<string>,
): number {
  const existing = cache.get(sessionKey);

  // Count total turns to decide when to start summarizing
  const totalTurns = countUserMessages(historyMessages) + (currentPrompt ? 1 : 0);

  cache.set(sessionKey, {
    summary: existing?.summary,
    summaryUpdateInProgress: existing?.summaryUpdateInProgress ?? false,
    liveMessages: historyMessages,
    currentPrompt,
    maxRecentTurns,
    contextTools,
    totalTurnsProcessed: totalTurns,
    lastSummarizedTurnCount: existing?.lastSummarizedTurnCount ?? 0,
    isSystemTrigger: isSystemTriggerPrompt(currentPrompt),
    standingInstructions: existing?.standingInstructions,
    standingInstructionsResolved: existing?.standingInstructionsResolved ?? false,
    updatedAt: Date.now(),
  });

  pruneCache();
  return totalTurns;
}

/**
 * Retrieve recent conversation turns for a session.
 *
 * Lazily extracts turns from the live message array each time,
 * so it always reflects the latest state — including tool results
 * that arrived after the initial `llm_input` hook fired.
 */
export function getRecentTurns(sessionKey: string): ConversationTurn[] {
  const entry = cache.get(sessionKey);
  if (!entry) return [];

  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
    cache.delete(sessionKey);
    return [];
  }

  const turns = extractConversationTurns(entry.liveMessages, entry.contextTools);

  // Append the current prompt (not in historyMessages yet)
  if (entry.currentPrompt && entry.currentPrompt.trim() && !entry.currentPrompt.startsWith("/")) {
    const cleanedPrompt = stripChannelMetadata(entry.currentPrompt.trim());
    if (cleanedPrompt && !cleanedPrompt.startsWith("/")) {
      turns.push({ user: cleanedPrompt });
    }
  }

  return filterSystemTurns(turns).slice(-entry.maxRecentTurns);
}

/**
 * Extract ALL conversation turns for summary generation input.
 * Unlike `getRecentTurns()`, this returns the full history (not sliced).
 */
export function getAllTurns(sessionKey: string): ConversationTurn[] {
  const entry = cache.get(sessionKey);
  if (!entry) return [];

  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
    return [];
  }

  const turns = extractConversationTurns(entry.liveMessages, entry.contextTools);

  if (entry.currentPrompt && entry.currentPrompt.trim() && !entry.currentPrompt.startsWith("/")) {
    const cleanedPrompt = stripChannelMetadata(entry.currentPrompt.trim());
    if (cleanedPrompt && !cleanedPrompt.startsWith("/")) {
      turns.push({ user: cleanedPrompt });
    }
  }

  return turns;
}

/**
 * Get the rolling summary for a session.
 */
export function getSummary(sessionKey: string): string | undefined {
  const entry = cache.get(sessionKey);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) return undefined;
  return entry.summary;
}

/**
 * Update the rolling summary for a session.
 */
export function updateSummary(sessionKey: string, summary: string): void {
  const entry = cache.get(sessionKey);
  if (!entry) return;
  entry.summary = summary;
  entry.summaryUpdateInProgress = false;
  entry.updatedAt = Date.now();
}

/**
 * Mark that a summary update is in progress for a session.
 */
export function markSummaryInProgress(sessionKey: string): void {
  const entry = cache.get(sessionKey);
  if (entry) entry.summaryUpdateInProgress = true;
}

/**
 * Mark that a summary update has completed (reset in-progress flag).
 * Called in the `.finally()` block after summary generation finishes
 * (whether successful, no-op, or failed).
 */
export function markSummaryComplete(sessionKey: string): void {
  const entry = cache.get(sessionKey);
  if (entry) entry.summaryUpdateInProgress = false;
}

/**
 * Check if a summary update is in progress for a session.
 */
export function isSummaryInProgress(sessionKey: string): boolean {
  const entry = cache.get(sessionKey);
  return entry?.summaryUpdateInProgress ?? false;
}

/**
 * Get the total turns processed for a session.
 */
export function getTotalTurns(sessionKey: string): number {
  const entry = cache.get(sessionKey);
  return entry?.totalTurnsProcessed ?? 0;
}

/**
 * Get the turn count at the time the last summary was generated.
 */
export function getLastSummarizedTurnCount(sessionKey: string): number {
  const entry = cache.get(sessionKey);
  return entry?.lastSummarizedTurnCount ?? 0;
}

/**
 * Record that a summary was generated at the current turn count.
 */
export function setLastSummarizedTurnCount(sessionKey: string, count: number): void {
  const entry = cache.get(sessionKey);
  if (entry) entry.lastSummarizedTurnCount = count;
}

/**
 * Check whether the current invocation is a system trigger (heartbeat, cron, etc.).
 * System triggers are trusted events — the guardian should not review their tool calls.
 */
export function isSystemTrigger(sessionKey: string): boolean {
  const entry = cache.get(sessionKey);
  return entry?.isSystemTrigger ?? false;
}

/**
 * Get the standing instructions for a session.
 */
export function getStandingInstructions(sessionKey: string): string | undefined {
  const entry = cache.get(sessionKey);
  return entry?.standingInstructions;
}

/**
 * Update the standing instructions for a session.
 */
export function updateStandingInstructions(
  sessionKey: string,
  instructions: string | undefined,
): void {
  const entry = cache.get(sessionKey);
  if (!entry) return;
  entry.standingInstructions = instructions;
  entry.standingInstructionsResolved = true;
}

/**
 * Check whether standing instructions have been resolved (extraction attempted).
 */
export function isStandingInstructionsResolved(sessionKey: string): boolean {
  const entry = cache.get(sessionKey);
  return entry?.standingInstructionsResolved ?? false;
}

/**
 * Get the available skills for a session.
 */
export function getAvailableSkills(sessionKey: string): string | undefined {
  const entry = cache.get(sessionKey);
  return entry?.availableSkills;
}

/**
 * Update the available skills for a session.
 */
export function updateAvailableSkills(sessionKey: string, skills: string | undefined): void {
  const entry = cache.get(sessionKey);
  if (!entry) return;
  entry.availableSkills = skills;
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

/**
 * Detect whether a prompt is a system trigger (heartbeat, cron, scheduled task).
 * These are trusted system events, not user conversations.
 */
function isSystemTriggerPrompt(prompt: string | undefined): boolean {
  if (!prompt) return false;
  const text = prompt.trim().toLowerCase();
  if (!text) return false;
  // Heartbeat patterns — direct "heartbeat" prefix
  if (/^heartbeat/i.test(text)) return true;
  // Heartbeat patterns — the default heartbeat prompt contains HEARTBEAT_OK or HEARTBEAT.md
  if (/heartbeat_ok/i.test(text) || /heartbeat\.md/i.test(text)) return true;
  // Cron/scheduled patterns (OpenClaw cron triggers start with /cron or contain cron metadata)
  if (/^\/cron\b/i.test(text)) return true;
  if (/^\[cron\]/i.test(text)) return true;
  // Status/health check patterns
  if (/^(ping|pong|health[_\s]?check|status[_\s]?check)$/i.test(text)) return true;
  return false;
}

/**
 * Filter out heartbeat/system-like turns from conversation context.
 * These confuse the guardian LLM (which may echo "HEARTBEAT_OK" instead
 * of producing an ALLOW/BLOCK verdict).
 */
function filterSystemTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.filter((turn) => {
    const text = turn.user.trim().toLowerCase();
    if (text.length < 3) return false;
    if (/^(heartbeat|ping|pong|health|status|ok|ack)$/i.test(text)) return false;
    if (/^heartbeat[_\s]?(ok|check|ping|test)?$/i.test(text)) return false;
    // Heartbeat prompts that mention HEARTBEAT_OK or HEARTBEAT.md
    if (/heartbeat_ok/i.test(text) || /heartbeat\.md/i.test(text)) return false;
    return true;
  });
}

/** Count user messages in the history array. */
function countUserMessages(historyMessages: unknown[]): number {
  let count = 0;
  for (const msg of historyMessages) {
    if (isMessageLike(msg) && msg.role === "user") {
      const text = extractTextContent(msg.content);
      if (text && !text.startsWith("/")) count++;
    }
  }
  return count;
}

/** Prune expired entries and enforce the max cache size (LRU by insertion order). */
function pruneCache(): void {
  const now = Date.now();

  for (const [key, entry] of cache) {
    if (now - entry.updatedAt > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }

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
 * assistant replies and tool results that preceded it (since the previous
 * user message).
 *
 * Tool results from allowlisted context tools are included as
 * `[tool: <name>] <text>` in the assistant section. This lets the guardian
 * see memory lookups, file contents, command output, etc.
 *
 * Trailing assistant/toolResult messages after the last user message are
 * appended to the last turn (for autonomous iteration support).
 */
export function extractConversationTurns(
  historyMessages: unknown[],
  contextTools?: Set<string>,
): ConversationTurn[] {
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

    // Handle tool results — include results from allowlisted tools
    if (msg.role === "toolResult") {
      const toolName =
        typeof (msg as Record<string, unknown>).toolName === "string"
          ? ((msg as Record<string, unknown>).toolName as string)
          : undefined;

      // Filter by context_tools allowlist
      if (
        contextTools &&
        contextTools.size > 0 &&
        (!toolName || !contextTools.has(toolName.toLowerCase()))
      ) {
        continue;
      }

      const text = extractToolResultText(msg);
      if (text) {
        assistantParts.push(text);
      }
      continue;
    }

    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      if (!text || text.startsWith("/")) {
        continue;
      }

      const mergedAssistant = mergeAssistantParts(assistantParts);
      turns.push({
        user: text,
        assistant: mergedAssistant,
      });
      assistantParts.length = 0;
    }
  }

  // Trailing assistant/toolResult messages → attach to last turn
  if (assistantParts.length > 0 && turns.length > 0) {
    const lastTurn = turns[turns.length - 1];
    const trailingAssistant = mergeAssistantParts(assistantParts);
    if (trailingAssistant) {
      lastTurn.assistant = lastTurn.assistant
        ? lastTurn.assistant + "\n" + trailingAssistant
        : trailingAssistant;
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
 * Extract text from a toolResult message, prefixed with `[tool: <name>]`.
 */
function extractToolResultText(msg: { role: string; content: unknown }): string | undefined {
  const toolName =
    typeof (msg as Record<string, unknown>).toolName === "string"
      ? ((msg as Record<string, unknown>).toolName as string)
      : "unknown_tool";

  const content = (msg as Record<string, unknown>).content;
  let text: string | undefined;

  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        parts.push(((block as Record<string, unknown>).text as string).trim());
      }
    }
    text = parts.join("\n").trim();
  }

  if (!text) return undefined;
  return `[tool: ${toolName}] ${text}`;
}

/**
 * Extract text content from a user message's content field.
 * Strips channel metadata blocks.
 */
function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return stripChannelMetadata(content.trim()) || undefined;
  }

  if (Array.isArray(content)) {
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
 */
function stripChannelMetadata(text: string): string {
  const metadataPattern = /Conversation info\s*\(untrusted metadata\)\s*:\s*```[\s\S]*?```/gi;

  let cleaned = text.replace(metadataPattern, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}
