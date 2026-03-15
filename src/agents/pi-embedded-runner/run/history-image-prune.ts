import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";
export const NO_VISION_IMAGE_MARKER = "[image data removed - model does not support vision]";

/**
 * Idempotent cleanup for sessions that contain image blocks in history.
 *
 * When `modelHasVision` is false, strips images from ALL turns to prevent
 * poison-turn loops where a failed image turn has no assistant reply and
 * is never pruned by the legacy heuristic (see #29290).
 *
 * When `modelHasVision` is true (or omitted), only strips images from
 * turns before the last assistant reply (legacy behavior).
 */
export function pruneProcessedHistoryImages(
  messages: AgentMessage[],
  options?: { modelHasVision?: boolean },
): boolean {
  const modelHasVision = options?.modelHasVision ?? true;

  let upperBound: number;
  if (modelHasVision) {
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
    upperBound = lastAssistantIndex;
  } else {
    upperBound = messages.length;
  }

  const marker = modelHasVision ? PRUNED_HISTORY_IMAGE_MARKER : NO_VISION_IMAGE_MARKER;
  let didMutate = false;
  for (let i = 0; i < upperBound; i++) {
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
        text: marker,
      } as (typeof message.content)[number];
      didMutate = true;
    }
  }

  return didMutate;
}
