import { describe, expect, it, vi } from "vitest";
import {
  createMessageUpdateContext,
  endMessage,
  firstMockArg,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";

describe("handleMessageUpdate text signatures", () => {
  it("emits the full incrementally extracted reasoning value on every delta", async () => {
    const emitReasoningStream = vi.fn();
    const context = createMessageUpdateContext({ emitReasoningStream });

    for (const chunk of ["<thi", "nk>reason", "ing</think>"]) {
      await updateMessage(
        context,
        createTextUpdateEvent({ type: "text_delta", text: chunk, delta: chunk }),
      );
    }

    expect(emitReasoningStream.mock.calls.map(([text]) => text)).toEqual([
      "",
      "reason",
      "reasoning",
    ]);
  });

  it.each([
    {
      name: "leading Unicode space and held paragraph breaks",
      chunks: ["\u2003Hello ", "world", "\n\n", "Next"],
      replies: [
        ["Hello", "Hello"],
        ["Hello world", " world"],
        ["Hello world\n\nNext", "\n\nNext"],
      ],
    },
  ])("uses incremental unphased Responses deltas with $name", async ({ chunks, replies }) => {
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn((text: string) => text);
    const context = createMessageUpdateContext({ onAgentEvent, stripBlockTags });

    const createNonPhaseEvent = (text: string, delta: string) =>
      ({
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial: {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.2",
            usage: {},
            timestamp: 0,
          },
        },
      }) as never;

    let text = "";
    for (const delta of chunks) {
      text += delta;
      await updateMessage(context, createNonPhaseEvent(text, delta));
    }

    expect(stripBlockTags.mock.calls.map(([value]) => value)).toEqual(chunks);
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
      replies.map(([value, delta]) => ({ stream: "assistant", data: { text: value, delta } })),
    );
  });

  it("treats unphased OpenAI Responses content-index changes as message boundaries", async () => {
    const flushBlockReplyBuffer = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      onPartialReply,
      state: {
        deltaBuffer: "First block",
        assistantStream: { raw: "First block", text: "First block" },
        lastAssistantStreamContentIndex: 0,
      },
    });
    const resetAssistantMessageState = vi.fn(() => {
      context.state.deltaBuffer = "";
      context.state.assistantStream = undefined;
    });
    context.resetAssistantMessageState = resetAssistantMessageState;
    context.params.onAssistantMessageStart = onAssistantMessageStart;

    const pending = updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 1,
        content: "First block",
        partial: {
          role: "assistant",
          content: [
            { type: "text", text: "First block" },
            { type: "text", text: "First block" },
          ],
          api: "openai-responses",
        },
      },
    });

    expect(flushBlockReplyBuffer.mock.calls).toEqual([
      [{ assistantMessageIndex: 0 }],
      [{ assistantMessageIndex: 0, final: true }],
    ]);
    expect(resetAssistantMessageState).toHaveBeenCalledTimes(1);
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "First block", delta: "First block" }),
    );
    expect(context.blockChunker.bufferedText).toBe("First block");
    expect(context.state.lastAssistantStreamContentIndex).toBe(1);
    await pending;
  });

  it.each([
    {
      name: "the directive accumulator has no parsed result",
      text: "answer part A msg [[E1008]timeout] answer part B",
      hasParsedDirectives: false,
    },
  ])("keeps literal final text when $name", async ({ text, hasParsedDirectives }) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({
      onAgentEvent,
      ...(hasParsedDirectives ? {} : { consumePartialReplyDirectives: vi.fn(() => null) }),
    });

    await updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_end", content: text },
    });

    expect(context.state.assistantStream?.text).toBe(text);
    expect(firstMockArg(onAgentEvent, "final assistant event")).toMatchObject({
      stream: "assistant",
      data: { text },
    });
  });

  it("keeps stripped reply directives out of later plain deltas", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    for (const text of ["[[reply_to_current]]\nHello", " world"]) {
      await updateMessage(context, createTextUpdateEvent({ type: "text_delta", text }));
    }

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { text: "Hello", delta: "Hello" },
      },
      {
        stream: "assistant",
        data: { text: "Hello world", delta: " world" },
      },
    ]);
  });

  it("does not expose complete legacy media directives on plain deltas", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    await updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Here it is.\nMEDIA:/tmp/final.png\n",
      },
    });

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: { text: "Here it is.", delta: "Here it is." },
    });
  });

  it("uses full partial text for suffix deltas after a suppressed commentary item", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Hello",
        delta: "Hello",
        id: "item-commentary",
        signaturePhase: "commentary",
        partialPhase: "commentary",
      }),
    );
    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Hello world",
        delta: " world",
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      // Emit-always: the commentary delta reaches the bus tagged with its
      // phase; reply lanes still exclude it (covered below).
      {
        stream: "assistant",
        data: {
          text: "Hello",
          delta: "",
          replace: true,
          phase: "commentary",
          itemId: "item-commentary",
        },
      },
      {
        stream: "assistant",
        data: { text: "Hello world", delta: "Hello world", phase: "final_answer" },
      },
    ]);
  });

  it.each(["openai-responses"])(
    "streams %s commentary with one complete-preamble boundary",
    async (api) => {
      const onAgentEvent = vi.fn();
      const context = createMessageUpdateContext({ onAgentEvent });
      // Exercise the real projection/deduplication owner. A raw callback mock
      // mistakes completion metadata for another assistant text message.
      context.emitAssistantStreamData = createReplyDelivery(context).emitAssistantStreamData;
      const createPartial = (text: string) => ({
        ...createOpenAiResponsesPartial({
          text,
          id: "item-commentary",
          signaturePhase: "commentary",
          partialPhase: "commentary",
        }),
        api,
      });
      const startPartial = createPartial("Work");
      const finalPartial = createPartial("Working...");

      for (const event of [
        { type: "text_start", partial: startPartial },
        { type: "text_delta", delta: "Work", partial: startPartial },
        { type: "text_delta", delta: "ing...", partial: finalPartial },
        { type: "text_end", content: "Working...", partial: finalPartial },
      ] as const) {
        await updateMessage(context, {
          message: event.partial,
          assistantMessageEvent: { ...event, contentIndex: 0 },
        });
      }
      await endMessage(context, {
        message: finalPartial,
      });

      expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual(
        [
          ["Work", "update"],
          ["Working...", "update"],
          ["Working...", "end"],
        ].map(([progressText, phase]) => ({
          stream: "item",
          data: {
            kind: "preamble",
            title: "Preamble",
            progressText,
            phase,
            itemId: "item-commentary",
          },
        })),
      );

      expect(context.state.deltaBuffer).toBe("Working...");
      expect(context.blockChunker.bufferedText).toBe("");
    },
  );

  it("keeps same-index commentary snapshot extensions on the original live item key", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    context.emitAssistantStreamData = createReplyDelivery(context).emitAssistantStreamData;
    const createPartial = (text: string, id: string) =>
      createOpenAiResponsesPartial({
        text,
        id,
        signaturePhase: "commentary",
        partialPhase: "commentary",
      });
    const firstPartial = createPartial("Working", "item-1");
    const extendedPartial = createPartial("Working now", "item-2");

    for (const event of [
      { type: "text_start", partial: firstPartial },
      { type: "text_end", content: "Working", partial: firstPartial },
      { type: "text_end", content: "Working now", partial: extendedPartial },
    ] as const) {
      await updateMessage(context, {
        message: event.partial,
        assistantMessageEvent: { ...event, contentIndex: 0 },
      });
    }
    await endMessage(context, { message: extendedPartial });

    // Both snapshots finish the same logical item. The later message_end must
    // not publish its already-observed completion again.
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual(
      ["Working", "Working now"].map((progressText) => ({
        stream: "item",
        data: { kind: "preamble", title: "Preamble", progressText, phase: "end", itemId: "item-1" },
      })),
    );

    expect(context.state.lastAssistantStreamItemId).toBe("item-1");
    expect(context.state.deltaBuffer).toBe("Working now");
  });
});

describe("commentary and flush isolation", () => {
  it("suppresses commentary partials when phase exists only in textSignature metadata", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const commentaryBlock = createOpenAiResponsesTextBlock({
      text: "Need send.",
      id: "msg_sig",
      phase: "commentary",
    });
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      flushBlockReplyBuffer,
    });

    await updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );
    await updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_end",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );

    // Archive-always: commentary (textSignature-only phase — the F3 shape) is
    // emitted on the bus for archival + window, but kept out of the reply lanes.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
    expect(ctx.state.deltaBuffer).toBe("");
    expect(ctx.blockChunker.bufferedText).toBe("");
  });

  it("contains synchronous text_end flush failures", async () => {
    const debug = vi.fn();
    const ctx = createMessageUpdateContext({
      debug,
      shouldEmitPartialReplies: false,
      flushBlockReplyBuffer: vi.fn(() => {
        throw new Error("boom");
      }),
    });

    const pending = updateMessage(ctx, createTextUpdateEvent({ type: "text_end", text: "" }));
    expect(debug).toHaveBeenCalledWith("text_end block reply flush failed: Error: boom");
    await pending;
  });
});
