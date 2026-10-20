import { expect, it, vi } from "vitest";
import { consumePendingAssistantReplyDirectivesIntoReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { extractAssistantStreamSnapshot } from "./embedded-agent-subscribe.handlers.messages.snapshot.js";
import {
  createMessageEndContext,
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const block = (text: string, id: string, phase: "commentary" | "final_answer" = "final_answer") =>
  createOpenAiResponsesTextBlock({ text, id, phase });
const finalEvent = (type: "text_delta" | "text_end", text: string) =>
  createTextUpdateEvent({
    type,
    text,
    id: "item-final",
    signaturePhase: "final_answer",
    partialPhase: "final_answer",
  });
const hiddenTool = [
  "Visible\n<tool_call>{",
  '"name":"read","arguments":{"file_path":"secret.md"}}</tool_call>',
  "\nDone.",
];
const runtimeContext = [
  "OpenClaw runtime cont",
  "ext:\nprivate\nEnd OpenClaw runtime context.\nVisible",
];
const visibleUpdates = [
  ["Visible", "Visible"],
  ["Visible\n\nDone.", "\n\nDone."],
] as const;
const helloUpdates = [
  ["Hello", "Hello"],
  ["Hello world", " world"],
] as const;
const voiceChunks = ["[[audio_as_", "voice]]Hello", " world"];
const targetChunks = ["[[reply_to:", "message-7]]Hello", " world"];
const targetReply = { replyToId: "message-7", replyToTag: true };

it("keeps prepared block and visible text stable when provider content changes", () => {
  const signature = JSON.stringify({ v: 1, id: "answer", phase: "final_answer" });
  const first = { type: "text" as const, text: "<final>Hello ", textSignature: signature };
  const second = { type: "text" as const, text: "world  </final>", textSignature: signature };
  const message = makeAgentAssistantMessage({
    content: [block("Working...", "working", "commentary"), first, second],
    model: "fixture",
  });
  const snapshot = extractAssistantStreamSnapshot(
    createMessageEndContext({ enforceFinalTag: true }),
    message,
  );

  expect(snapshot.rawText).toBe("<final>Hello world  </final>");
  expect(snapshot.blockText).toBe("Hello \nworld  ");
  first.text = "Changed first block";
  second.text = "Changed second block";
  first.textSignature = JSON.stringify({ v: 1, id: "answer", phase: "commentary" });
  message.content = [];

  expect(snapshot.text).toBe("Hello\nworld");
  expect({ ...snapshot }.text).toBe("Hello\nworld");
});

it("uses the prepared error context after the provider changes it", () => {
  const message = makeAgentAssistantMessage({
    content: [{ type: "text", text: "400 Incorrect role information" }],
    model: "fixture",
    stopReason: "error",
  });
  const snapshot = extractAssistantStreamSnapshot(createMessageEndContext(), message);
  message.stopReason = "stop";
  expect(snapshot.text).toContain("Message ordering conflict");
});
it("honors explicit commentary metadata supplied after initial deltas", async () => {
  const onAgentEvent = vi.fn();
  const context = createMessageUpdateContext({ onAgentEvent });
  const narration = "I'll check the repo first.";
  await updateMessage(context, {
    message: {
      role: "assistant",
      api: "openai-responses",
      content: [{ type: "text", text: narration }],
    },
    assistantMessageEvent: { type: "text_delta", delta: narration },
  });
  await updateMessage(context, {
    message: { role: "assistant", api: "openai-responses", content: [] },
    assistantMessageEvent: {
      type: "text_end",
      content: narration,
      partial: makeAgentAssistantMessage({
        content: [block(narration, "commentary-0", "commentary")],
      }),
    },
  });

  expect(onAgentEvent.mock.calls.map(([event]) => event)).toContainEqual(
    expect.objectContaining({
      stream: "assistant",
      data: expect.objectContaining({
        text: narration,
        replace: true,
        phase: "commentary",
        itemId: "commentary-0",
      }),
    }),
  );
});

it.each([
  ["sanitizer", hiddenTool, visibleUpdates, undefined],
  ["runtime context", runtimeContext, [["Visible", "Visible"]], undefined],
  ["voice directive", voiceChunks, helloUpdates, { audioAsVoice: true }],
  ["reply target", targetChunks, helloUpdates, targetReply],
] as const)(
  "uses append events for same-item phased streams (%s)",
  async (_name, chunks, updates, reply) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const signature = JSON.stringify({ v: 1, id: "item-final", phase: "final_answer" });
    const partial = {
      role: "assistant",
      phase: "final_answer",
      content: [
        {
          type: "text",
          textSignature: signature,
          get text() {
            throw new Error("full partial text should not be read");
          },
        },
      ],
    };

    for (const chunk of chunks) {
      await updateMessage(context, {
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: chunk, partial },
      });
    }

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
      updates.map(([text, delta]) => ({
        stream: "assistant",
        data: { text, delta, replace: undefined, phase: "final_answer" },
      })),
    );
    if (reply) {
      expect(
        consumePendingAssistantReplyDirectivesIntoReply(context.state, { text: "Hello world" }),
      ).toMatchObject(reply);
    }
  },
);

it("replaces a phased reply with an empty final snapshot", async () => {
  const onAgentEvent = vi.fn();
  const context = createMessageUpdateContext({ onAgentEvent });
  for (const [type, text] of [
    ["text_delta", "Hello world"],
    ["text_delta", ""],
    ["text_end", ""],
  ] as const) {
    const pending = updateMessage(context, finalEvent(type, text));
    if (type === "text_delta") {
      expect(onAgentEvent).toHaveBeenCalledTimes(1);
    }
    await pending;
  }

  expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
    {
      stream: "assistant",
      data: { text: "Hello world", delta: "Hello world", replace: undefined },
    },
    { stream: "assistant", data: { text: "", delta: "", replace: true } },
  ]);
  expect(context.blockChunker.bufferedText).toBe("");
});

it("does not replay a deferred item snapshot before its first delta", async () => {
  const context = createMessageUpdateContext({
    flushBlockReplyBuffer: vi.fn(),
    resetAssistantMessageState: vi.fn(),
    onPartialReply: vi.fn(),
    state: {
      lastAssistantStreamContentIndex: 0,
      lastAssistantStreamItemId: "item-1",
      assistantMessageIndex: 7,
    },
  });
  context.params.onAssistantMessageStart = vi.fn();
  const partial = {
    role: "assistant",
    phase: "final_answer",
    api: "openai-responses",
    content: [block("First block", "item-1"), block("Second block", "item-2")],
  };

  const startPending = updateMessage(context, {
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 1, partial },
  });
  const deltaPending = updateMessage(context, {
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Second block" },
  });

  expect(context.flushBlockReplyBuffer).toHaveBeenCalledExactlyOnceWith({
    assistantMessageIndex: 7,
  });
  expect(context.resetAssistantMessageState).toHaveBeenCalledExactlyOnceWith(0);
  expect(context.params.onAssistantMessageStart).toHaveBeenCalledTimes(1);
  expect(context.params.onPartialReply).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      text: "Second block",
      delta: "Second block",
      phase: "final_answer",
    }),
  );
  expect(context.state).toMatchObject({
    lastAssistantStreamContentIndex: 1,
    lastAssistantStreamItemId: "item-2",
  });
  await Promise.all([startPending, deltaPending]);
});

it("preserves phase-aware voice and reply directives while deferring final media delivery", async () => {
  const ctx = createMessageUpdateContext({
    state: { blockReplyBreak: "message_end" },
  });
  const replyText = "Done.\n\n[[reply_to_current]]\n[[audio_as_voice]]\nMEDIA:/tmp/reply.ogg";

  for (const type of ["text_delta", "text_end"] as const) {
    await updateMessage(ctx, finalEvent(type, replyText));
  }

  expect(ctx.blockChunker.bufferedText).toBe("Done.\n\n");
  expect(consumePendingAssistantReplyDirectivesIntoReply(ctx.state, { text: "Done." })).toEqual({
    text: "Done.",
    audioAsVoice: true,
    replyToId: undefined,
    replyToTag: true,
    replyToCurrent: true,
  });
  expect(ctx.state.pendingAssistantReplyDirectives).toBeUndefined();
});
