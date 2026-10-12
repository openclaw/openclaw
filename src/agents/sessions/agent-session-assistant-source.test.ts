import { expect, it } from "vitest";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { subscribeEmbeddedAgentSession } from "../embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AssistantTranscriptSource } from "./assistant-transcript-source.js";

registerAgentSessionLoopTestLifecycle();

it("binds delivered blocks to their own committed assistant occurrence without delaying publication", async () => {
  const { session, sessionManager } = await createTestSession();
  const replies: ReplyPayload[] = [];
  const sources: AssistantTranscriptSource[] = [];
  const atPublication: Array<string | undefined> = [];
  const publishedTimestamps: number[] = [];
  session.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      expect(event.assistantTranscriptSource).toBeDefined();
      sources.push(event.assistantTranscriptSource!);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      expect(event.assistantTranscriptSource).toBe(sources.at(-1));
      atPublication.push(event.assistantTranscriptSource?.messageId);
      expect(JSON.stringify(event)).not.toContain(event.assistantTranscriptSource?.occurrenceId);
      // Preserve the established synchronous listener contract: replacing the
      // published message must still change the exact message being persisted.
      event.message = { ...event.message, timestamp: event.message.timestamp + 1 };
      publishedTimestamps.push(event.message.timestamp);
    }
  });
  const subscription = subscribeEmbeddedAgentSession({
    session,
    runId: "same-logical-run",
    blockReplyBreak: "message_end",
    onBlockReply: (payload) => {
      replies.push(payload);
    },
  });
  const text = "Same answer.\nMEDIA:https://example.test/preview.png";
  streamMocks.streamSimple.mockImplementation(() =>
    createAssistantResultStream(createAssistant(testModel, [{ type: "text", text }])),
  );
  try {
    await session.prompt("first input");
    await subscription.waitForPendingEvents();
    await session.prompt("second input");
    await subscription.waitForPendingEvents();
    const entries = sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message")
      .filter((entry) => entry.message.role === "assistant");
    expect(entries).toHaveLength(2);
    expect(sources).toHaveLength(2);
    expect(atPublication).toEqual([undefined, undefined]);
    expect(entries.map((entry) => entry.message.timestamp)).toEqual(publishedTimestamps);
    expect(sources.map((source) => source.messageId)).toEqual(entries.map((entry) => entry.id));
    expect(new Set(sources.map((source) => source.occurrenceId)).size).toBe(2);
    expect(
      replies
        .filter((reply) => reply.mediaUrls?.length)
        .map((reply) => getReplyPayloadMetadata(reply)?.assistantTranscriptSource),
    ).toEqual(sources);
    expect(
      replies
        .filter((reply) => reply.mediaUrls?.length)
        .map((reply) => getReplyPayloadMetadata(reply)?.assistantTranscriptAggregate),
    ).toEqual([true, true]);
    expect(subscription.getLastAssistantTranscriptSource()).toBe(sources[1]);
    for (const source of sources) {
      expect(JSON.stringify(entries)).not.toContain(source.occurrenceId);
    }
  } finally {
    subscription.unsubscribe();
  }
});
