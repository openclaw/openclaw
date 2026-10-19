import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentSourceMessagingToolPartial } from "./embedded-agent-helpers/messaging-dedupe.js";
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

function updateText(
  context: ReturnType<typeof createMessageUpdateContext>,
  type: "text_delta" | "text_end",
  text: string,
  options: Omit<Parameters<typeof createTextUpdateEvent>[0], "type" | "text"> = {},
) {
  return updateMessage(context, createTextUpdateEvent({ type, text, ...options }));
}
const commentaryPartial = (text: string, id = "item-commentary") =>
  createOpenAiResponsesPartial({
    text,
    id,
    signaturePhase: "commentary",
    partialPhase: "commentary",
  });
const preamble = (progressText: string, phase: string, itemId = "item-commentary") => ({
  stream: "item",
  data: { kind: "preamble", title: "Preamble", progressText, phase, itemId },
});

describe("handleMessageUpdate text signatures", () => {
  afterEach(() => vi.useRealTimers());

  it("emits the full incrementally extracted reasoning value on every delta", async () => {
    const emitReasoningStream = vi.fn();
    const context = createMessageUpdateContext({ emitReasoningStream });

    for (const chunk of ["<thi", "nk>reason", "ing</think>"]) {
      await updateText(context, "text_delta", chunk, { delta: chunk });
    }

    expect(emitReasoningStream.mock.calls.map(([text]) => text)).toEqual([
      "",
      "reason",
      "reasoning",
    ]);
  });

  it("uses incremental unphased Responses deltas with Unicode space and held paragraph breaks", async () => {
    const chunks = ["\u2003Hello ", "world", "\n\n", "Next"];
    const replies = [
      ["Hello", "Hello"],
      ["Hello world", " world"],
      ["Hello world\n\nNext", "\n\nNext"],
    ];
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn((text: string) => text);
    const context = createMessageUpdateContext({ onAgentEvent, stripBlockTags });

    let text = "";
    for (const delta of chunks) {
      text += delta;
      await updateMessage(context, {
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial: {
            ...createOpenAiResponsesPartial({ text, id: "unused" }),
            content: [{ type: "text", text }],
          },
        },
      });
    }

    expect(stripBlockTags.mock.calls.map(([value]) => value)).toEqual(chunks);
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
      replies.map(([value, delta]) => ({ stream: "assistant", data: { text: value, delta } })),
    );
  });

  it("does not expose complete legacy media directives on plain deltas", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    await updateText(context, "text_delta", "Here it is.\nMEDIA:/tmp/final.png\n");

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: { text: "Here it is.", delta: "Here it is." },
    });
  });

  it.each([
    [["NO_", "REPLY", "\nHello ", "world"], "Hello world"],
    [["NO_", "REPLY", " is literal ", "text"], "NO_REPLY is literal text"],
  ] as const)("preserves visible text after a split protocol prefix: %j", async (chunks, text) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    for (const delta of chunks) {
      await updateText(context, "text_delta", delta);
    }

    const replies = onAgentEvent.mock.calls.map(([event]) => event.data);
    expect(replies.map((reply) => reply.delta).join("")).toBe(text);
    expect(replies.at(-1)?.text).toBe(text);
    expect(context.getPartialReplySourceText()).toBe(text);
  });

  it("uses full partial text for suffix deltas after a suppressed commentary item", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    await updateText(context, "text_delta", "Hello", {
      delta: "Hello",
      id: "item-commentary",
      signaturePhase: "commentary",
      partialPhase: "commentary",
    });
    await updateText(context, "text_delta", "Hello world", {
      delta: " world",
      id: "item-final",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
      [
        { text: "Hello", delta: "", replace: true, phase: "commentary", itemId: "item-commentary" },
        { text: "Hello world", delta: "Hello world", phase: "final_answer" },
      ].map((data) => ({ stream: "assistant", data })),
    );
  });

  it.each([
    { delayMs: 0, updates: ["Work"] },
    { delayMs: 100, updates: ["Work", "Working..."] },
  ])(
    "streams commentary with one complete-preamble boundary (delta delay=$delayMs ms)",
    async ({ delayMs, updates }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);
      const onAgentEvent = vi.fn();
      const context = createMessageUpdateContext({ onAgentEvent });
      // Real projection distinguishes completion metadata from a second text message.
      context.emitAssistantStreamData = createReplyDelivery(context).emitAssistantStreamData;
      const startPartial = commentaryPartial("Work");
      const finalPartial = commentaryPartial("Working...");

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
        vi.setSystemTime(Date.now() + delayMs);
      }
      await endMessage(context, { message: finalPartial });

      expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual([
        ...updates.map((text) => preamble(text, "update")),
        preamble("Working...", "end"),
      ]);

      expect(context.state.deltaBuffer).toBe("Working...");
      expect(context.blockChunker.bufferedText).toBe("");
    },
  );

  it("keeps same-index commentary snapshot extensions on the original live item key", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    context.emitAssistantStreamData = createReplyDelivery(context).emitAssistantStreamData;
    const firstPartial = commentaryPartial("Working", "item-1");
    const extendedPartial = commentaryPartial("Working now", "item-2");

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

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual(
      ["Working", "Working now"].map((text) => preamble(text, "end", "item-1")),
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

    await updateText(ctx, "text_delta", "Need send.", { content: [commentaryBlock] });
    await updateText(ctx, "text_end", "Need send.", { content: [commentaryBlock] });

    // Signature-only commentary is archived but excluded from reply lanes.
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

    const pending = updateText(ctx, "text_end", "");
    expect(debug).toHaveBeenCalledWith("text_end block reply flush failed: Error: boom");
    await pending;
  });
});

describe("handleMessageUpdate current-source message-tool previews", () => {
  it("holds delta-only continuation fragments and releases one full divergent snapshot", () => {
    const state = {
      currentSourceMessagingToolHeldPartial: undefined as string | undefined,
      currentSourceMessagingToolSentTextsNormalized: ["qa-msteams-dm-ok"],
    };

    const partial = (text: string) =>
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text,
        visibleDelta: text,
      });
    for (const [fragment, hold, text] of [
      ["QA-MSTEAMS", true, "QA-MSTEAMS"],
      ["-DM-OK", true, "QA-MSTEAMS-DM-OK"],
      [" with more detail", false, "QA-MSTEAMS-DM-OK with more detail"],
    ] as const) {
      expect(partial(fragment)).toEqual({ hold, text });
    }
    expect(state.currentSourceMessagingToolHeldPartial).toBeUndefined();
  });

  it("holds automatic partial prefixes and exact duplicates after source delivery", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const sentText = "QA-MSTEAMS-DM-OK";
    const context = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      sourceReplyDeliveryMode: "automatic",
      state: {
        currentSourceMessagingToolSentTextsNormalized: [sentText.toLowerCase()],
      },
    });

    await updateText(context, "text_delta", "QA-MSTEAMS", { id: "msg_source_duplicate" });
    await updateText(context, "text_end", sentText, { id: "msg_source_duplicate" });

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onPartialReply).not.toHaveBeenCalled();
  });
});
