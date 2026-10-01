import { isCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { calculateContextTokens, estimateContextTokens } from "../runtime/index.js";
import { AgentSessionModels } from "./agent-session-models.js";
import {
  estimateMessagesFromContent,
  extractTextContent,
  hasPersistedAssistantContent,
} from "./agent-session-utils.js";
import type { ContextUsage } from "./extensions/index.js";
import { getLatestCompactionEntry } from "./session-manager.js";

export abstract class AgentSessionInspection extends AgentSessionModels {
  /** Set the current session's display name. */
  setSessionName(name: string): void {
    this.sessionManager.appendSessionInfo(name);
    this.emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
  }

  getContextUsage(): ContextUsage | undefined {
    const model = this.model;
    if (!model) {
      return undefined;
    }

    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) {
      return undefined;
    }

    // After compaction, the last assistant usage reflects pre-compaction context size.
    // We can only trust usage from an assistant that responded after the latest compaction.
    // If no such assistant exists, context token count is unknown until the next LLM response.
    const branchEntries = this.sessionManager.getBranch();
    const latestCompaction = getLatestCompactionEntry(branchEntries);
    const providerCheckpointIndex = branchEntries.findLastIndex(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        isCompactionReplayCheckpoint(entry.message.providerReplay),
    );
    const clientCompactionIndex = latestCompaction
      ? branchEntries.lastIndexOf(latestCompaction)
      : -1;
    const compactionIndex = Math.max(clientCompactionIndex, providerCheckpointIndex);
    const providerCheckpoint = providerCheckpointIndex > clientCompactionIndex;
    let estimateFromContent = false;

    if (compactionIndex >= 0) {
      let hasPostCompactionUsage = false;
      for (let index = branchEntries.length - 1; index > compactionIndex; index -= 1) {
        // SAFETY: The reverse index stays within the canonical branch entries.
        const entry = branchEntries[index]!;
        if (entry.type === "message" && entry.message.role === "assistant") {
          const assistant = entry.message;
          if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
            // Inspection has no prepared auth identity to select replay content.
            // Stay unknown until a later provider measurement owns that window.
            if (providerCheckpoint && assistant.usage.contextUsage?.state !== "available") {
              continue;
            }
            if (assistant.usage.contextUsage?.state === "unavailable") {
              estimateFromContent = true;
              continue;
            }
            const contextTokens = calculateContextTokens(assistant.usage);
            if (contextTokens > 0) {
              hasPostCompactionUsage = true;
              estimateFromContent = false;
              break;
            }
          }
        }
      }

      if (!hasPostCompactionUsage && (providerCheckpoint || !estimateFromContent)) {
        return { tokens: null, contextWindow, percent: null };
      }
    }

    const tokens = estimateFromContent
      ? estimateMessagesFromContent(this.messages)
      : estimateContextTokens(this.messages).tokens;
    const percent = (tokens / contextWindow) * 100;

    return {
      tokens,
      contextWindow,
      percent,
    };
  }

  /**
   * Get text content of last assistant message.
   * Useful for /copy command.
   * @returns Text content, or undefined if no assistant message exists
   */
  getLastAssistantText(): string | undefined {
    const messages = this.messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      // SAFETY: The reverse index stays within the canonical message array.
      const message = messages[index]!;
      if (message.role !== "assistant") {
        continue;
      }
      const content = message.content;
      if (message.stopReason === "aborted" && !hasPersistedAssistantContent(content)) {
        continue;
      }
      return extractTextContent(content).trim() || undefined;
    }
    return undefined;
  }
}
