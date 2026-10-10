import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasPersistedMedia } from "../../sessions/user-turn-media.js";

const DUPLICATE_USER_MESSAGE_WINDOW_MS = 60_000;
const MIN_DUPLICATE_USER_MESSAGE_CHARS = 24;

type MessageLike = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  __openclaw?: unknown;
};

function normalizeUserMessageContent(rawContent: unknown): string | undefined {
  let content = rawContent;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (!isRecord(block) || block.type === "image") {
        return undefined;
      }
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }
    content = textParts.join("\n");
  }
  return typeof content === "string" ? content.replace(/\s+/g, " ").trim() : undefined;
}

function duplicateSignature(message: unknown): { key: string; timestamp: number } | undefined {
  if (!isRecord(message) || message.role !== "user" || typeof message.timestamp !== "number") {
    return undefined;
  }
  const text = normalizeUserMessageContent(message.content);
  if (!text || text.length < MIN_DUPLICATE_USER_MESSAGE_CHARS || hasPersistedMedia(message)) {
    return undefined;
  }
  // Persisted sender identity keeps distinct participants separate while senderless legacy
  // turns retain the old retry behavior. A JSON tuple avoids sender/text delimiter collisions.
  const metadata = message["__openclaw"];
  const senderId =
    isRecord(metadata) && typeof metadata.senderId === "string" ? metadata.senderId : "";
  return {
    key: JSON.stringify([senderId, text.normalize("NFC")]),
    timestamp: message.timestamp,
  };
}

/** Drop later duplicate user messages while preserving the first prompt. */
export function dedupeDuplicateUserMessagesForCompaction<T extends MessageLike>(
  messages: readonly T[],
): T[] {
  const lastSeenAtByKey = new Map<string, number>();
  const result: T[] = [];
  for (const message of messages) {
    const signature = duplicateSignature(message);
    if (!signature) {
      // A reply ends the retry batch; identical later asks are real user turns.
      if (message.role === "assistant") {
        lastSeenAtByKey.clear();
      }
      result.push(message);
      continue;
    }
    const lastSeenAt = lastSeenAtByKey.get(signature.key);
    const newestTimestamp = Math.max(lastSeenAt ?? signature.timestamp, signature.timestamp);
    lastSeenAtByKey.set(signature.key, newestTimestamp);
    if (
      typeof lastSeenAt === "number" &&
      signature.timestamp >= lastSeenAt &&
      signature.timestamp - lastSeenAt <= DUPLICATE_USER_MESSAGE_WINDOW_MS
    ) {
      // Keep the first prompt and drop only later repeats. The first copy anchors the summarized
      // branch while duplicate retries no longer inflate compaction context.
      continue;
    }
    result.push(message);
  }
  return result;
}
