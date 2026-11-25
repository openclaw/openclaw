import type { AttemptTranscriptMessage as TranscriptMessage } from "./attempt-transcript-replay.js";
import { readIdempotencyKey } from "./attempt-transcript-replay.js";
import type { AttemptParamsLike } from "./attempt-types.js";

type InMemoryTranscriptManager = NonNullable<AttemptParamsLike["sessionManager"]>;
type MemoryAppendResult = {
  anchor?: undefined;
  appended: boolean;
  message: TranscriptMessage;
  messageId: string;
};

export function findInMemoryMessage(
  manager: InMemoryTranscriptManager,
  message: TranscriptMessage,
): MemoryAppendResult | undefined {
  const key = readIdempotencyKey(message);
  if (!key) {
    return undefined;
  }
  for (const entry of manager.getEntries()) {
    if (entry.type === "message" && readIdempotencyKey(entry.message) === key) {
      return {
        appended: false,
        // SAFETY: Journal identity keys belong to its user/assistant/toolResult writes; the manager exposes the wider AgentMessage envelope.
        message: entry.message as TranscriptMessage,
        messageId: entry.id,
      };
    }
  }
  return undefined;
}

export async function appendInMemoryMessage(
  manager: InMemoryTranscriptManager,
  message: TranscriptMessage,
): Promise<MemoryAppendResult> {
  const previous = findInMemoryMessage(manager, message);
  if (previous) {
    return previous;
  }
  const result = await manager.appendMessageWithTranscriptAnchorAsync(message);
  return {
    appended: result.appended,
    // SAFETY: The manager canonicalizes this typed journal message without changing its role; optional user metadata remains structurally compatible.
    message: result.message as TranscriptMessage,
    messageId: result.entryId,
  };
}
