import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/**
 * Idempotent cleanup for legacy sessions that persisted image blocks in history.
 * Called each run; mutates only user turns that already have an assistant reply.
 */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): boolean {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex < 0) {
    return false;
  }

  let didMutate = false;
  for (let i = 0; i < lastAssistantIndex; i++) {
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
