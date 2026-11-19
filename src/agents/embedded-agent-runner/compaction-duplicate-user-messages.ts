import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasPersistedMedia } from "../../sessions/user-turn-media.js";

const DUPLICATE_USER_MESSAGE_WINDOW_MS = 60_000;
export const MIN_DUPLICATE_USER_MESSAGE_CHARS = 24;

type MessageLike = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  __openclaw?: unknown;
};

export function normalizeUserMessageContent(rawContent: unknown): string | undefined {
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

function duplicateUserMessageSignature(
  message: unknown,
): { key: string; timestamp: number } | undefined {
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

export type DuplicateUserSignature = { key: string; timestamp: number };

/** Hash buckets select comparisons only. The caller must answer every equality exactly. */
export function* dedupeDuplicateUserSequence<T>(
  messages: readonly T[],
  adapter: {
    role(message: T): unknown;
    signature(message: T): DuplicateUserSignature | undefined;
  },
): Generator<readonly [T, T], T[], boolean> {
  const buckets = new Map<string, Array<{ message: T; timestamp: number }>>();
  const result: T[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const role = adapter.role(message);
    if (
      role === "user" &&
      buckets.size === 0 &&
      (index + 1 === messages.length || adapter.role(messages[index + 1]!) === "assistant")
    ) {
      result.push(message);
      continue;
    }
    const signature = adapter.signature(message);
    if (!signature) {
      if (role === "assistant") {
        buckets.clear();
      }
      result.push(message);
      continue;
    }
    const bucket = buckets.get(signature.key) ?? [];
    let previous: (typeof bucket)[number] | undefined;
    for (const candidate of bucket) {
      if (yield [candidate.message, message] as const) {
        previous = candidate;
        break;
      }
    }
    const last = previous?.timestamp;
    if (previous) {
      previous.timestamp = Math.max(previous.timestamp, signature.timestamp);
    } else {
      bucket.push({ message, timestamp: signature.timestamp });
      buckets.set(signature.key, bucket);
    }
    if (
      typeof last === "number" &&
      signature.timestamp >= last &&
      signature.timestamp - last <= DUPLICATE_USER_MESSAGE_WINDOW_MS
    ) {
      continue;
    }
    result.push(message);
  }
  return result;
}

/** Drop later duplicate user messages while preserving the first prompt. */
export function dedupeDuplicateUserMessagesForCompaction<T extends MessageLike>(
  messages: readonly T[],
): T[] {
  const sequence = dedupeDuplicateUserSequence<T>(messages, {
    role: (message) => message.role,
    signature: duplicateUserMessageSignature,
  });
  let step = sequence.next();
  while (!step.done) {
    const [left, right] = step.value;
    step = sequence.next(
      duplicateUserMessageSignature(left)?.key === duplicateUserMessageSignature(right)?.key,
    );
  }
  return step.value;
}
