import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/** Default number of recent images to retain in history. */
export const DEFAULT_KEEP_LAST_IMAGES = 5;

/** Location of an image block in the message array. */
interface ImageLocation {
  messageIndex: number;
  blockIndex: number;
}

/**
 * Idempotent cleanup for sessions that persisted image blocks in history.
 * Called each run; mutates only user/toolResult turns that already have an assistant reply.
 * Retains the most recent `keepLastN` images to preserve context for follow-up questions.
 */
export function pruneProcessedHistoryImages(
  messages: AgentMessage[],
  keepLastN: number = DEFAULT_KEEP_LAST_IMAGES,
): boolean {
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

  // Collect all image locations before lastAssistantIndex
  const imageLocations: ImageLocation[] = [];
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
      if ((block as { type?: string }).type === "image") {
        imageLocations.push({ messageIndex: i, blockIndex: j });
      }
    }
  }

  // Keep the last N images, only prune older ones
  const pruneCount = Math.max(0, imageLocations.length - keepLastN);
  if (pruneCount === 0) {
    return false;
  }

  let didMutate = false;
  // Prune only the oldest images (first `pruneCount` in the array)
  for (let k = 0; k < pruneCount; k++) {
    const loc = imageLocations[k];
    if (!loc) {
      continue;
    }
    const message = messages[loc.messageIndex];
    if (
      !message ||
      (message.role !== "user" && message.role !== "toolResult") ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    message.content[loc.blockIndex] = {
      type: "text",
      text: PRUNED_HISTORY_IMAGE_MARKER,
    } as (typeof message.content)[number];
    didMutate = true;
  }

  return didMutate;
}
