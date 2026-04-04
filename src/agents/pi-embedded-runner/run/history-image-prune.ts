import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/**
 * Number of most-recent assistant turns whose preceding user/toolResult image blocks are
 * kept intact. Pruning these would diverge the request bytes from what the provider
 * cached on the previous turn, invalidating the prompt-cache prefix.
 */
const PRESERVE_RECENT_COMPLETED_TURNS = 3;

function resolvePruneBeforeIndex(messages: AgentMessage[]): number {
  const completedTurnStarts: number[] = [];
  let currentTurnStart = -1;
  let currentTurnHasAssistantReply = false;

  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") {
      if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
        completedTurnStarts.push(currentTurnStart);
      }
      currentTurnStart = i;
      currentTurnHasAssistantReply = false;
      continue;
    }
    if (role === "toolResult") {
      if (currentTurnStart < 0) {
        currentTurnStart = i;
      }
      continue;
    }
    if (role === "assistant" && currentTurnStart >= 0) {
      currentTurnHasAssistantReply = true;
    }
  }

  if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
    completedTurnStarts.push(currentTurnStart);
  }

  if (completedTurnStarts.length <= PRESERVE_RECENT_COMPLETED_TURNS) {
    return -1;
  }
  return completedTurnStarts[completedTurnStarts.length - PRESERVE_RECENT_COMPLETED_TURNS];
}

/**
 * Idempotent cleanup for legacy sessions that persisted image blocks in history.
 * Called each run; mutates only completed turns older than
 * {@link PRESERVE_RECENT_COMPLETED_TURNS} so recent turns remain
 * byte-identical for prompt caching.
 */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): boolean {
  const pruneBeforeIndex = resolvePruneBeforeIndex(messages);
  if (pruneBeforeIndex < 0) {
    return false;
  }

  let didMutate = false;
  for (let i = 0; i < pruneBeforeIndex; i++) {
    const message = messages[i];
    if (
      !message ||
      (message.role !== "user" && message.role !== "toolResult") ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (!block || typeof block !== "object") {
        continue;
      }
      if ((block as { type?: string }).type !== "image") {
        continue;
      }
      message.content[j] = {
        type: "text",
        text: PRUNED_HISTORY_IMAGE_MARKER,
      } as (typeof message.content)[number];
      didMutate = true;
    }
  }

  return didMutate;
}
