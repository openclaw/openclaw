import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens, findCutPoint, type SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentCompactionStartupPruningConfig } from "../config/types.agent-defaults.js";
import { resolveContextWindowInfo } from "./context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";

/**
 * Prunes a session's message history on startup if it exceeds the configured target tokens.
 * This prevents loading bloated sessions that would immediately hit context limits.
 *
 * Uses pi-coding-agent's findCutPoint() to determine where to prune, then creates
 * a new branched session file containing only the kept entries.
 *
 * @param sessionManager The Pi SessionManager instance with loaded transcript
 * @param config Startup pruning configuration
 * @param provider Model provider (e.g., "anthropic")
 * @param modelId Model ID (e.g., "claude-sonnet-4-0")
 * @returns True if pruning was applied, false otherwise
 */
export async function applyStartupPruning(params: {
  sessionManager: SessionManager;
  config: AgentCompactionStartupPruningConfig;
  provider: string;
  modelId: string;
}): Promise<boolean> {
  const { sessionManager, config, provider, modelId } = params;

  // Check if startup pruning is enabled
  if (!config.enabled) {
    return false;
  }

  // Get all session entries
  const allEntries = sessionManager.getEntries();

  if (allEntries.length === 0) {
    return false;
  }

  // Get context window for this model
  const contextWindowInfo = resolveContextWindowInfo({
    cfg: undefined,
    provider,
    modelId,
    modelContextWindow: undefined,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  const contextWindow = contextWindowInfo.tokens;

  // Determine target tokens (default: 80% of context window)
  const targetTokens = config.targetTokens ?? Math.floor(contextWindow * 0.8);

  // Get current session context (resolved messages sent to LLM)
  const sessionContext = sessionManager.buildSessionContext();
  const messages = sessionContext.messages;

  // Estimate current token count using sum of individual message estimates
  const currentTokens = estimateMessagesTokens(messages);

  // Check if pruning is needed
  if (currentTokens <= targetTokens) {
    return false;
  }

  // Calculate tokens to keep (leave some buffer)
  const keepRecentTokens = Math.floor(targetTokens * 0.9);

  // Find where to cut based on token budget
  const cutResult = findCutPoint(allEntries, 0, allEntries.length, keepRecentTokens);

  if (cutResult.firstKeptEntryIndex === 0) {
    // No pruning needed - all entries fit within target
    return false;
  }

  // Get the entry ID to branch from
  const firstKeptEntry = allEntries[cutResult.firstKeptEntryIndex];
  if (!firstKeptEntry) {
    console.warn("[startup-pruning] Could not find first kept entry");
    return false;
  }

  const strategy = config.strategy ?? "keep-recent";
  const droppedCount = cutResult.firstKeptEntryIndex;
  const keptCount = allEntries.length - droppedCount;

  // Sanity check: warn if keeping fewer than minRecentMessages
  const minRecentMessages = config.minRecentMessages ?? 10;
  const keptMessageCount = allEntries
    .slice(cutResult.firstKeptEntryIndex)
    .filter((e) => e.type === "message").length;

  if (keptMessageCount < minRecentMessages) {
    console.warn(
      `[startup-pruning] Keeping only ${keptMessageCount} messages (min: ${minRecentMessages}), but proceeding to stay under token limit`,
    );
  }

  // Create a new branched session with only kept entries
  // First, we need to branch to just before the first kept entry
  const parentOfKept = firstKeptEntry.parentId;

  if (!parentOfKept) {
    console.warn("[startup-pruning] First kept entry has no parent - cannot prune");
    return false;
  }

  try {
    let newSessionPath: string | undefined;

    if (strategy === "keep-summarized") {
      // TODO: Add summarization of dropped messages
      // For now, fall back to keep-recent
      console.warn("[startup-pruning] keep-summarized not yet implemented, using keep-recent");
    }

    // Branch to the parent of the first kept entry
    sessionManager.branch(parentOfKept);

    // Create a branched session from the first kept entry
    // This will create a new file with only the path from root to first kept entry
    const leafId = sessionManager.getLeafId();
    if (leafId) {
      newSessionPath = sessionManager.createBranchedSession(leafId);
    }

    if (!newSessionPath) {
      console.warn("[startup-pruning] Failed to create branched session");
      return false;
    }

    console.log(
      `[startup-pruning] Pruned ${droppedCount} entries, kept ${keptCount} (${currentTokens} → ~${keepRecentTokens} tokens)`,
    );
    console.log(`[startup-pruning] New session file: ${newSessionPath}`);

    // Switch to the new session file
    sessionManager.setSessionFile(newSessionPath);

    return true;
  } catch (error) {
    console.error("[startup-pruning] Error during pruning:", error);
    return false;
  }
}

/**
 * Estimate total tokens for an array of messages
 */
function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}
