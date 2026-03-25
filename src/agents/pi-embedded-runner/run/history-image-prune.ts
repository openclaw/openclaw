import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/**
 * Number of most-recent assistant turns whose preceding user/toolResult image blocks are
 * kept intact. Pruning these would diverge the request bytes from what the provider
 * cached on the previous turn, invalidating the prompt-cache prefix.
 */
const PRESERVE_RECENT_ASSISTANT_TURNS = 3;

/**
 * Idempotent cleanup for legacy sessions that persisted image blocks in history.
 * Called each run; mutates only user turns that are older than
 * {@link PRESERVE_RECENT_ASSISTANT_TURNS} assistant replies so recent turns remain
 * byte-identical for prompt caching.
 */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): boolean {
  let assistantSeen = 0;
  let pruneBeforeIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      assistantSeen++;
      if (assistantSeen >= PRESERVE_RECENT_ASSISTANT_TURNS) {
        pruneBeforeIndex = i;
        break;
      }
    }
  }
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
