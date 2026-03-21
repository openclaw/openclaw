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

/**
 * Hook point for stripping inline image content before session JSONL
 * persistence. Currently a pass-through: images must NOT be stripped at
 * write time because at that point the image has not yet been consumed by a
 * subsequent assistant turn. Stripping immediately would cause crash/retry
 * recovery to fail — the model can no longer re-read the image payload from
 * session history.
 *
 * Image cleanup is handled correctly by `pruneProcessedHistoryImages`, which
 * runs at each run start and only removes images from turns that already have
 * a later assistant reply (the `lastAssistantIndex` safety boundary).
 */
export function stripImageContentForPersistence(message: AgentMessage): AgentMessage {
  return message;
}
