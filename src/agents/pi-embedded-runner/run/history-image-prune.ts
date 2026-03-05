import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/**
 * Idempotent cleanup: strips image blocks from historical user messages.
 * Called each run before prompt. Prunes images from any user message that
 * has been answered (an assistant message exists after it). Also prunes
 * images from any user message that is NOT the last user message, even
 * without an assistant reply — this prevents context overflow loops where
 * a failed first turn (e.g. overflow) leaves images stuck forever.
 */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): boolean {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex < 0) {
    return false;
  }

  // Prune images from user messages that are either:
  // 1. Before the last assistant message (already answered), OR
  // 2. Not the last user message (stale from a failed prior turn)
  const pruneUpTo = Math.max(lastAssistantIndex, lastUserIndex);

  let didMutate = false;
  for (let i = 0; i < pruneUpTo; i++) {
    const message = messages[i];
    if (!message || message.role !== "user" || !Array.isArray(message.content)) {
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
