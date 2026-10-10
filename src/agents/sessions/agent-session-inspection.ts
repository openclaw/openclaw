import { isCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { AssistantMessage } from "../../llm/types.js";
import { calculateContextTokens, estimateContextTokens } from "../runtime/index.js";
import { AgentSessionModels } from "./agent-session-models.js";
import {
  estimateMessagesFromContent,
  extractTextContent,
  hasPersistedAssistantContent,
} from "./agent-session-utils.js";
import type { ContextUsage } from "./extensions/index.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import { warnSessionPersistenceDeprecation } from "./session-persistence-deprecation.js";

export abstract class AgentSessionInspection extends AgentSessionModels {
  /** @deprecated Use setSessionNameAsync; removed at the next Plugin SDK major. */
  setSessionName(name: string): void {
    warnSessionPersistenceDeprecation("AgentSession.setSessionName", "setSessionNameAsync");
    this.sessionManager.appendSessionInfo(name);
    this.emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
  }

  /** Persist the display name before publishing its changed event. */
  async setSessionNameAsync(name: string): Promise<void> {
    const manager = this.sessionManager;
    const target = manager.getSessionTarget();
    const sessionId = manager.getSessionId();
    const assertCurrent = target ? captureOwnedTranscriptWriteAssertion(target) : undefined;
    await manager.appendSessionInfoAsync(name);
    assertCurrent?.();
    if (
      this.sessionManager !== manager ||
      manager.getSessionId() !== sessionId ||
      !sameSessionTranscriptTargetBinding(target, manager.getSessionTarget())
    ) {
      throw new Error("Session changed before publishing its display name");
    }
    this.emit({ type: "session_info_changed", name: manager.getSessionName() });
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
    let usageSource: "unknown" | "content" | "provider" = "unknown";

    if (compactionIndex >= 0) {
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
              usageSource = "content";
              continue;
            }
            const contextTokens = calculateContextTokens(assistant.usage);
            if (contextTokens > 0) {
              usageSource = "provider";
              break;
            }
          }
        }
      }

      if (usageSource !== "provider" && (providerCheckpoint || usageSource !== "content")) {
        return { tokens: null, contextWindow, percent: null };
      }
    }

    const tokens =
      usageSource === "content"
        ? estimateMessagesFromContent(this.messages)
        : estimateContextTokens(this.messages).tokens;
    const percent = (tokens / contextWindow) * 100;

    return {
      tokens,
      contextWindow,
      percent,
    };
  }

  getLastAssistantText(): string | undefined {
    const message = this.messages.findLast(
      (entry): entry is AssistantMessage =>
        entry.role === "assistant" &&
        (entry.stopReason !== "aborted" || hasPersistedAssistantContent(entry.content)),
    );
    return message ? extractTextContent(message.content).trim() || undefined : undefined;
  }
}
