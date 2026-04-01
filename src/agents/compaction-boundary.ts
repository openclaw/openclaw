import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractToolCallsFromAssistant } from "./tool-call-id.js";

/**
 * Find safe compaction boundaries in a message sequence.
 *
 * A boundary is a message index where splitting is safe — i.e., right after
 * a complete tool_use/toolResult pair. Splitting between a tool_use and its
 * toolResult produces orphaned messages that cause API errors downstream.
 *
 * Returns a Set of indices where a split may occur (between index and index+1).
 */
export function findCompactionBoundaries(messages: AgentMessage[]): Set<number> {
  const boundaries = new Set<number>();
  const pendingToolCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      const toolCalls = extractToolCallsFromAssistant(msg);
      for (const tc of toolCalls) {
        pendingToolCallIds.add(tc.id);
      }

      // If this assistant message has no tool calls, it's a safe boundary.
      if (toolCalls.length === 0 && pendingToolCallIds.size === 0) {
        boundaries.add(i);
      }
    } else if (msg.role === "toolResult") {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      if (toolCallId) {
        pendingToolCallIds.delete(toolCallId);
      }

      // All pending tool calls resolved — safe to split after this message.
      if (pendingToolCallIds.size === 0) {
        boundaries.add(i);
      }
    } else {
      // user or system messages are safe boundaries when no tool calls are pending.
      if (pendingToolCallIds.size === 0) {
        boundaries.add(i);
      }
    }
  }

  return boundaries;
}

/**
 * Snap a proposed split index to the nearest safe compaction boundary.
 *
 * Searches backward from the proposed index first (preferring earlier splits
 * to avoid oversized chunks), then forward if no earlier boundary is found.
 * Returns the original index if no boundary exists at all.
 */
export function snapToBoundary(
  proposed: number,
  boundaries: Set<number>,
  minIndex: number,
  maxIndex: number,
): number {
  // Search backward first (prefer splitting earlier to keep chunks smaller)
  for (let i = proposed; i >= minIndex; i--) {
    if (boundaries.has(i)) {
      return i;
    }
  }
  // Search forward
  for (let i = proposed + 1; i <= maxIndex; i++) {
    if (boundaries.has(i)) {
      return i;
    }
  }
  return proposed;
}
