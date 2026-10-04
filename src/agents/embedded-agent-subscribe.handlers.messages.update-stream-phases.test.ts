import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
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
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

function twoBlockPartial() {
  return {
    role: "assistant",
    phase: "final_answer",
    api: "openai-responses",
    content: [
      createOpenAiResponsesTextBlock({ text: "First block", id: "item-1", phase: "final_answer" }),
      createOpenAiResponsesTextBlock({ text: "Second block", id: "item-2", phase: "final_answer" }),
    ],
  };
}

describe("assistant stream snapshots", () => {
  it("keeps prepared block and visible text stable when provider content changes", () => {
    const signature = JSON.stringify({ v: 1, id: "answer", phase: "final_answer" });
    const first = { type: "text" as const, text: "<final>Hello ", textSignature: signature };
    const second = { type: "text" as const, text: "world  </final>", textSignature: signature };
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Working...",
          textSignature: JSON.stringify({ v: 1, id: "working", phase: "commentary" }),
        },
        first,
        second,
      ],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: 0,
    };
    const snapshot = extractAssistantStreamSnapshot(
      createMessageEndContext({ enforceFinalTag: true }),
      message,
    );

    expect(snapshot.rawText).toBe("<final>Hello \nworld  </final>");
    expect(snapshot.blockText).toBe("Hello \nworld  ");
    first.text = "Changed first block";
    second.text = "Changed second block";
    first.textSignature = JSON.stringify({ v: 1, id: "answer", phase: "commentary" });
    message.content = [];

    expect(snapshot.text).toBe("Hello\nworld");
    expect({ ...snapshot }.text).toBe("Hello\nworld");
  });

  it.each(["error"] as const)(
    "uses the prepared %s error context after the provider changes it",
    (stopReason) => {
      const sourceText = "400 Incorrect role information";
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: sourceText }],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        usage: createZeroUsageFixture(),
        stopReason,
        timestamp: 0,
      };
      const snapshot = extractAssistantStreamSnapshot(createMessageEndContext(), message);
      message.stopReason = stopReason === "error" ? "stop" : "error";

      expect(snapshot.text).toEqual(
        stopReason === "error" ? expect.stringContaining("Message ordering conflict") : sourceText,
      );
    },
  );
});

describe("handleMessageUpdate text signatures", () => {
  it("emits a commentary snapshot when Anthropic text is classified after deltas", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const narration = "I'll check the repo first.";
    const commentaryPartial = {
      role: "assistant",
      api: "anthropic-messages",
      content: [
        {
          type: "text",
          text: narration,
          textSignature: JSON.stringify({ v: 1, id: "commentary-0", phase: "commentary" }),
        },
      ],
    };

    await updateMessage(context, {
      message: {
        role: "assistant",
        api: "anthropic-messages",
        content: [{ type: "text", text: narration }],
      },
      assistantMessageEvent: { type: "text_delta", delta: narration },
    });
    await updateMessage(context, {
      message: { role: "assistant", api: "anthropic-messages", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: narration,
        partial: commentaryPartial,
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
    {
      name: "user-visible sanitizer",
      chunks: [
        "Visible\n<tool_call>{",
        '"name":"read","arguments":{"file_path":"secret.md"}}</tool_call>',
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "split runtime-context header",
      chunks: ["OpenClaw runtime cont", "ext:\nprivate\nEnd OpenClaw runtime context.\nVisible"],
      updates: [{ text: "Visible", delta: "Visible" }],
    },
    {
      name: "held GLM arg_key tool call",
      chunks: [
        "Visible\n<tool_call>exec",
        "<arg_key>command</arg_key><arg_value>secret</arg_value></tool_call>",
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "held GLM arg_key after whitespace",
      chunks: [
        "Visible\n<tool_call>exec ",
        "<arg_key>command</arg_key><arg_value>secret</arg_value></tool_call>",
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "held GLM arg_key after newline",
      chunks: [
        "Visible\n<tool_call>exec\n",
        "<arg_key>command</arg_key><arg_value>secret</arg_value></tool_call>",
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "held GLM one-character tool name",
      chunks: [
        "Visible\n<tool_call>x",
        "<arg_key>command</arg_key><arg_value>secret</arg_value></tool_call>",
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "held GLM arg_key split inside the tag name",
      chunks: [
        "Visible\n<tool_call>exec<arg_",
        "key>command</arg_key><arg_value>secret</arg_value></tool_call>",
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "held GLM arg_key split before the last letters",
      chunks: [
        "Visible\n<tool_call>exec<arg_ke",
        "y>command</arg_key><arg_value>secret</arg_value></tool_call>",
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "held GLM arg_key split inside the first closing tag",
      chunks: [
        "Visible\n<tool_call>exec<arg_key>command",
        "</arg_",
        "key><arg_value>redacted</arg_value></tool_call>\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "held GLM first key split at formatting whitespace",
      chunks: [
        "Visible\n<tool_call>exec<arg_key>command",
        " \n",
        "</arg_key><arg_value>private</arg_value></tool_call>\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "held GLM first key split around formatting whitespace",
      chunks: [
        "Visible\n<tool_call>exec<arg_key>\n",
        "command\n",
        "</arg_key><arg_value>private</arg_value></tool_call>\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "releases leading-space GLM literal prose without borrowing a later close",
      chunks: ["Use <tool_call>exec<arg_key> ", "literally. Example: `</arg_key>`."],
      updates: [
        { text: "Use", delta: "Use" },
        {
          text: "Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.",
          delta: " <tool_call>exec<arg_key> literally. Example: `</arg_key>`.",
        },
      ],
    },
    {
      name: "releases a terminal literal GLM marker after later prose",
      chunks: ["Use <tool_call>exec", " now."],
      updates: [
        { text: "Use", delta: "Use" },
        { text: "Use <tool_call>exec now.", delta: " <tool_call>exec now." },
      ],
    },
    {
      name: "split voice directive",
      chunks: ["[[audio_as_", "voice]]Hello", " world"],
      updates: [
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ],
      reply: { audioAsVoice: true },
    },
    {
      name: "split reply target",
      chunks: ["[[reply_to:", "message-7]]Hello", " world"],
      updates: [
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ],
      reply: { replyToId: "message-7", replyToTag: true },
    },
    {
      name: "duplicate paragraph becomes distinct",
      chunks: ["One.\n\n", "One.", " More."],
      updates: [
        { text: "One.", delta: "One." },
        { text: "One.\n\nOne. More.", delta: "\n\nOne. More." },
      ],
    },
  ])(
    "uses append events for same-item phased streams ($name)",
    async ({ chunks, updates, reply }) => {
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

      const createPhasedDelta = (delta: string) =>
        ({
          message: { role: "assistant", content: [] },
          assistantMessageEvent: {
            type: "text_delta",
            delta,
            partial,
          },
        }) as never;

      for (const chunk of chunks) {
        await updateMessage(context, createPhasedDelta(chunk));
      }

      expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
        updates.map((data) => ({
          stream: "assistant",
          data: { ...data, replace: undefined, phase: "final_answer" },
        })),
      );
      if (reply) {
        expect(
          consumePendingAssistantReplyDirectivesIntoReply(context.state, { text: "Hello world" }),
        ).toMatchObject(reply);
      }
    },
  );

  it.each([""])("replaces a phased reply with the final snapshot %j", async (finalText) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    for (const event of [
      { type: "text_delta" as const, text: "Hello world", delta: "Hello world" },
      { type: "text_delta" as const, text: "", delta: "" },
      { type: "text_end" as const, text: finalText },
    ]) {
      const pending = updateMessage(
        context,
        createTextUpdateEvent({
          ...event,
          id: "item-final",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      );
      if (event.type === "text_delta") {
        expect(onAgentEvent).toHaveBeenCalledTimes(1);
      }
      await pending;
    }

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { text: "Hello world", delta: "Hello world", replace: undefined },
      },
      { stream: "assistant", data: { text: finalText, delta: "", replace: true } },
    ]);
    expect(context.blockChunker.bufferedText).toBe(finalText);
  });

  it("does not replay a deferred item snapshot before its first delta", async () => {
    const flushBlockReplyBuffer = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      resetAssistantMessageState,
      onPartialReply,
      state: {
        lastAssistantStreamContentIndex: 0,
        lastAssistantStreamItemId: "item-1",
        assistantMessageIndex: 7,
      },
    });
    context.params.onAssistantMessageStart = onAssistantMessageStart;
    const partial = twoBlockPartial();

    const startPending = updateMessage(context, {
      message: partial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 1,
        partial,
      },
    });
    const deltaPending = updateMessage(context, {
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Second block",
      },
    });

    expect(flushBlockReplyBuffer).toHaveBeenCalledExactlyOnceWith({ assistantMessageIndex: 7 });
    expect(resetAssistantMessageState).toHaveBeenCalledExactlyOnceWith(0);
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Second block",
        delta: "Second block",
        phase: "final_answer",
      }),
    );
    expect(context.state.lastAssistantStreamContentIndex).toBe(1);
    expect(context.state.lastAssistantStreamItemId).toBe("item-2");
    await Promise.all([startPending, deltaPending]);
  });

  it("scopes item-id fallback boundaries to the matching signed block", async () => {
    const onPartialReply = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const context = createMessageUpdateContext({
      onPartialReply,
      resetAssistantMessageState,
      state: { lastAssistantStreamItemId: "item-1" },
    });

    await updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Second block",
        partial: twoBlockPartial(),
      },
    });

    expect(resetAssistantMessageState).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Second block",
        delta: "Second block",
        phase: "final_answer",
      }),
    );
    expect(onPartialReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "First block\nSecond block" }),
    );
    expect(context.state.lastAssistantStreamContentIndex).toBeUndefined();
    expect(context.state.lastAssistantStreamItemId).toBe("item-2");
  });

  it("preserves phase-aware voice and reply directives while deferring final media delivery", async () => {
    const ctx = createMessageUpdateContext({
      state: {
        blockReplyBreak: "message_end",
      },
    });
    const replyText = "Done.\n\n[[reply_to_current]]\n[[audio_as_voice]]\nMEDIA:/tmp/reply.ogg";

    for (const type of ["text_delta", "text_end"] as const) {
      await updateMessage(
        ctx,
        createTextUpdateEvent({
          type,
          text: replyText,
          id: "item-final",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      );
    }

    expect(ctx.blockChunker.bufferedText).toBe("Done.\n\n");
    expect(
      consumePendingAssistantReplyDirectivesIntoReply(ctx.state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      audioAsVoice: true,
      replyToId: undefined,
      replyToTag: true,
      replyToCurrent: true,
    });
    expect(ctx.state.pendingAssistantReplyDirectives).toBeUndefined();
  });
});
