import {
  hasRuntimeContextMarker,
  isRuntimeContextMessage,
  readRuntimeContextMetadata,
  type Context,
} from "@openclaw/llm-core";

/**
 * Responses continuation requires the complete prior input before tool output. A turn's
 * carrier stays with its user/checkpoint; a steering or retained carrier stays where first
 * sent. `anchoredAtStart`: an emitted checkpoint anchors an otherwise userless tail.
 */
export function anchorRuntimeContextCarriers<T extends Context["messages"][number]>(
  messages: T[],
  anchoredAtStart: boolean,
): T[] {
  if (!messages.some(hasRuntimeContextMarker)) {
    return messages;
  }
  const anchored: T[] = [];
  let insertionIndex = anchoredAtStart ? 0 : undefined;
  for (const [index, message] of messages.entries()) {
    const next = messages[index + 1];
    const previous = anchored[(insertionIndex ?? 0) - 1];
    const steering =
      previous &&
      hasRuntimeContextMarker(previous) &&
      next?.role === "user" &&
      !hasRuntimeContextMarker(next);
    const retained =
      isRuntimeContextMessage(message) && readRuntimeContextMetadata(message).retained === true;
    if (
      hasRuntimeContextMarker(message) &&
      !retained &&
      insertionIndex !== undefined &&
      !steering
    ) {
      anchored.splice(insertionIndex++, 0, message);
      continue;
    }
    anchored.push(message);
    if (!hasRuntimeContextMarker(message) && message.role === "user") {
      insertionIndex = anchored.length;
    }
  }
  return anchored;
}
