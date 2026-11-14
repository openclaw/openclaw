import { hasRuntimeContextMarker, type Context } from "@openclaw/llm-core";
import type { ResponseCompactionItemParam } from "openai/resources/responses/responses.js";

type ReplayItem = Context["messages"][number] | ResponseCompactionItemParam;

function isCarrier(item: ReplayItem): item is Context["messages"][number] {
  return "role" in item && hasRuntimeContextMarker(item);
}

/**
 * Place runtime-context carriers for Responses replay.
 *
 * Responses continuation requires the complete prior input before tool output. A carrier
 * persisted after output it preceded on the wire (async replay) returns before that output, but
 * never past its preceding user or checkpoint, never before an item older than itself (that item
 * was already sent without it), and never between a tool call and its result. A carrier that
 * first appears mid-run (steering) therefore stays where it was appended.
 */
export function orderResponsesRuntimeContextCarriers<T extends ReplayItem>(
  items: T[],
  options: { anchoredAtStart: boolean },
): T[] {
  if (!items.some(isCarrier)) {
    return items;
  }
  const anchored: T[] = [];
  // A canonical window is already emitted; its checkpoint anchors an otherwise userless tail.
  let insertionIndex = options.anchoredAtStart ? 0 : undefined;
  for (const item of items) {
    if (isCarrier(item) && insertionIndex !== undefined) {
      let index = anchored.length;
      while (index > insertionIndex) {
        const earlier = anchored.at(index - 1);
        if (!earlier || !("timestamp" in earlier) || earlier.timestamp <= item.timestamp) {
          break;
        }
        index -= 1;
      }
      const earlierCalls = new Set(
        anchored
          .slice(0, index)
          .flatMap((earlier) =>
            "role" in earlier && earlier.role === "assistant"
              ? earlier.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
              : [],
          ),
      );
      const splitsToolRound = anchored
        .slice(index)
        .some(
          (later) =>
            "role" in later && later.role === "toolResult" && earlierCalls.has(later.toolCallId),
        );
      anchored.splice(splitsToolRound ? anchored.length : index, 0, item);
      continue;
    }
    anchored.push(item);
    if (!isCarrier(item) && ("role" in item ? item.role === "user" : item.type === "compaction")) {
      insertionIndex = anchored.length;
    }
  }
  return anchored;
}
