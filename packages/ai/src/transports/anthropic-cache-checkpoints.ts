import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Message checkpoint selection for the Anthropic cache allocator in anthropic-payload-policy.ts.

function isUserMessageRecord(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && message.role === "user";
}

/** A user message starts a turn when it carries text or an image, not only tool results. */
function carriesUserTurnContent(message: Record<string, unknown>): boolean {
  const { content } = message;
  if (typeof content === "string") {
    return content.length > 0;
  }
  return (
    Array.isArray(content) &&
    content.some((block) => isRecord(block) && (block.type === "text" || block.type === "image"))
  );
}

/**
 * Last block of the assistant message at `index` that may carry a breakpoint. Only non-empty
 * text and tool_use qualify; thinking and server-side compaction blocks never take cache_control.
 */
function findAssistantCacheableTail(
  messages: ReadonlyArray<unknown>,
  index: number,
): Record<string, unknown> | undefined {
  const message = messages[index];
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i];
    if (
      isRecord(block) &&
      (block.type === "tool_use" ||
        (block.type === "text" && typeof block.text === "string" && block.text.length > 0))
    ) {
      return block;
    }
  }
  return undefined;
}

/**
 * Stable history boundaries, newest first: the end of the assistant message before the newest
 * user turn (written now) and before the turn preceding it (the boundary the previous request
 * wrote). A turn is a run of consecutive user messages, so a runtime-context carrier belongs to
 * the turn it follows. Everything before the newest turn replays byte-stable, while the newest
 * turn's own messages are re-rendered between requests. Callers pass only the messages before
 * the earliest opted-out (transient) message.
 */
export function findStableHistoryBoundaries(
  messages: ReadonlyArray<unknown>,
): Record<string, unknown>[] {
  const boundaries: Record<string, unknown>[] = [];
  let turns = 0;
  let i = messages.length - 1;
  while (i >= 0 && turns < 2) {
    if (!isUserMessageRecord(messages[i])) {
      i--;
      continue;
    }
    let startsTurn = false;
    for (; i >= 0; i--) {
      const message = messages[i];
      if (!isUserMessageRecord(message)) {
        break;
      }
      startsTurn ||= carriesUserTurnContent(message);
    }
    if (startsTurn) {
      turns++;
      const boundary = findAssistantCacheableTail(messages, i);
      if (boundary) {
        boundaries.push(boundary);
      }
    }
  }
  return boundaries;
}

/**
 * Whether the newest run of user messages is a new turn after an assistant reply: its first
 * message carries text or an image. A run that begins with tool results continues the previous
 * request's tail, so its user checkpoints stay first.
 */
export function startsNewUserTurn(messages: ReadonlyArray<unknown>): boolean {
  let i = messages.length - 1;
  while (i > 0 && isUserMessageRecord(messages[i - 1])) {
    i--;
  }
  const first = messages[i];
  return i > 0 && isUserMessageRecord(first) && carriesUserTurnContent(first);
}

/** Marker for a user message's last text, image or tool_result block, if it has one. */
export function resolveUserCheckpoint(
  record: unknown,
  cacheControl: Record<string, unknown>,
): (() => void) | undefined {
  if (!isUserMessageRecord(record)) {
    return undefined;
  }
  const content = record.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks)) {
    return undefined;
  }
  for (let j = blocks.length - 1; j >= 0; j--) {
    const block = blocks[j];
    if (
      isRecord(block) &&
      (block.type === "text" || block.type === "image" || block.type === "tool_result")
    ) {
      return () => {
        block.cache_control = cacheControl;
        if (typeof content === "string") {
          record.content = blocks;
        }
      };
    }
  }
  return undefined;
}
