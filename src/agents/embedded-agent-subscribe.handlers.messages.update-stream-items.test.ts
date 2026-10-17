import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmbeddedBlockChunker,
  type BlockChunkMetadata,
  type BlockReplyChunking,
} from "./embedded-agent-block-chunker.js";
import { resolveCurrentSourceMessagingToolPartial } from "./embedded-agent-helpers/messaging-dedupe.js";
import { extractAssistantStreamSnapshot } from "./embedded-agent-subscribe.handlers.messages.snapshot.js";
import {
  createMessageEndContext,
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
  afterEach(() => vi.useRealTimers());

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

  it.each([
    { chunks: ["NO_", "REPLY", "\nHello ", "world"], text: "Hello world" },
    {
      chunks: ["NO_", "REPLY", " is literal ", "text"],
      text: "NO_REPLY is literal text",
    },
  ])("preserves visible text after a split protocol prefix: $text", async ({ chunks, text }) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    for (const delta of chunks) {
      await updateMessage(context, {
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta },
      });
    }

    const replies = onAgentEvent.mock.calls.map(([event]) => event.data);
    expect(replies.map((reply) => reply.delta).join("")).toBe(text);
    expect(replies.at(-1)?.text).toBe(text);
    expect(context.getPartialReplySourceText()).toBe(text);
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
      // Exercise the real projection/deduplication owner. A raw callback mock
      // mistakes completion metadata for another assistant text message.
      context.emitAssistantStreamData = createReplyDelivery(context).emitAssistantStreamData;
      const createPartial = (text: string) =>
        createOpenAiResponsesPartial({
          text,
          id: "item-commentary",
          signaturePhase: "commentary",
          partialPhase: "commentary",
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
        vi.setSystemTime(Date.now() + delayMs);
      }
      await endMessage(context, {
        message: finalPartial,
      });

      expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual(
        [...updates.map((text) => [text, "update"]), ["Working...", "end"]].map(
          ([progressText, phase]) => ({
            stream: "item",
            data: {
              kind: "preamble",
              title: "Preamble",
              progressText,
              phase,
              itemId: "item-commentary",
            },
          }),
        ),
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

describe("handleMessageUpdate current-source message-tool previews", () => {
  it("holds delta-only continuation fragments and releases one full divergent snapshot", () => {
    const state = {
      currentSourceMessagingToolHeldPartial: undefined as string | undefined,
      currentSourceMessagingToolSentTextsNormalized: ["qa-msteams-dm-ok"],
    };

    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: "QA-MSTEAMS",
        visibleDelta: "QA-MSTEAMS",
      }),
    ).toEqual({ hold: true, text: "QA-MSTEAMS" });
    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: "-DM-OK",
        visibleDelta: "-DM-OK",
      }),
    ).toEqual({ hold: true, text: "QA-MSTEAMS-DM-OK" });
    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: " with more detail",
        visibleDelta: " with more detail",
      }),
    ).toEqual({ hold: false, text: "QA-MSTEAMS-DM-OK with more detail" });
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

    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "QA-MSTEAMS",
        id: "msg_source_duplicate",
      }),
    );
    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_end",
        text: sentText,
        id: "msg_source_duplicate",
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onPartialReply).not.toHaveBeenCalled();
  });
});

describe("tagged block reply streaming", () => {
  // Tagged providers wrap the reply in <final>. Block replies are prepared from the
  // tag-stripped source; every step must leave the chunker exactly where the canonical
  // full-snapshot reconciliation would, and only verbatim appends may skip it.
  function createTaggedStream(phase?: "final_answer", chunking?: BlockReplyChunking) {
    const onBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      enforceFinalTag: true,
      onBlockReply,
      ...(chunking ? { blockReplyChunking: chunking, state: { blockReplyBreak: "text_end" } } : {}),
    });
    const stripBlockTags = ctx.stripBlockTags;
    let stripChars = 0;
    ctx.stripBlockTags = (text, state, options) => {
      stripChars += text.length;
      return stripBlockTags(text, state, options);
    };
    const parts: string[] = [];
    const message = {
      role: "assistant",
      ...(phase ? { phase } : {}),
      content: [] as unknown[],
    };
    const fast: boolean[] = [];
    let totalStripChars = 0;
    const syncContent = () => {
      message.content = parts.map((text) => ({ type: "text", text }));
    };
    const canonicalBlockText = (contentIndex: number, final: boolean) => {
      const blockText = extractAssistantStreamSnapshot(ctx, message as never, {
        throughIndex: contentIndex,
        ...(final ? {} : { observedText: ctx.state.streamBlockText }),
        final,
      }).blockText;
      // Phase-aware streams restart the chunker at each block; it holds the scope's own text.
      const scopeStart = ctx.state.blockReplyScopeStart?.contentIndex ?? 0;
      if (scopeStart === 0) {
        return blockText;
      }
      const prefix = `${
        extractAssistantStreamSnapshot(ctx, message as never, {
          throughIndex: scopeStart - 1,
          final: false,
        }).blockText
      }
`;
      return blockText.slice(prefix.length);
    };
    return {
      ctx,
      fast,
      onBlockReply,
      canonicalBlockText,
      get stripChars() {
        return totalStripChars;
      },
      async delta(delta: string, contentIndex = 0) {
        parts[contentIndex] = (parts[contentIndex] ?? "") + delta;
        syncContent();
        stripChars = 0;
        await updateMessage(ctx, {
          message,
          assistantMessageEvent: { type: "text_delta", contentIndex, delta },
        });
        // The stream strips each chunk once; a canonical snapshot strips the whole prefix again.
        fast.push(stripChars === delta.length);
        totalStripChars += stripChars;
        // A chunking stream drains mid-stream, so its caller compares the consumed state.
        if (!chunking) {
          expect(ctx.blockChunker.bufferedText).toBe(canonicalBlockText(contentIndex, false));
        }
      },
      async textEnd(content: string, contentIndex = 0) {
        parts[contentIndex] = content;
        syncContent();
        await updateMessage(ctx, {
          message,
          assistantMessageEvent: { type: "text_end", contentIndex, content, partial: message },
        });
        expect(ctx.blockChunker.bufferedText).toBe(canonicalBlockText(contentIndex, true));
      },
    };
  }

  const phases = [undefined, "final_answer"] as const;

  it.each(phases)("appends markup-free deltas of a tagged stream (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of [
      "<final>Hello wor",
      "ld, this is",
      " a plain stream",
      " with more words\n\n",
      "and another paragraph.",
    ]) {
      await stream.delta(delta);
    }
    expect(stream.fast).toEqual([false, true, true, true, true]);
    expect(stream.ctx.blockChunker.bufferedText).toBe(
      "Hello world, this is a plain stream with more words\n\nand another paragraph.",
    );
  });

  it.each(phases)("keeps hidden reasoning before <final> canonical (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of [
      "<think>plan the answer",
      "</think>",
      "I will answer now. ",
      "<final>",
      "Answer",
      " continues",
      " here.",
    ]) {
      await stream.delta(delta);
    }
    // Nothing is visible until text follows the opener, so "Answer" still reconciles.
    expect(stream.fast).toEqual([false, false, false, false, false, true, true]);
    expect(stream.ctx.blockChunker.bufferedText).toBe("Answer continues here.");
  });

  it.each(phases)("reconciles a <final> tag split across deltas (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of ["<fi", "nal>Hello", " world", " again"]) {
      await stream.delta(delta);
    }
    expect(stream.fast).toEqual([false, false, true, true]);
    expect(stream.ctx.blockChunker.bufferedText).toBe("Hello world again");
  });

  it.each(phases)("reconciles code fences and spans (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of [
      "<final>Before\n",
      "```ts\n",
      "const a = 1;\n",
      "const b = 2;\n",
      "```\n",
      "After `inline",
      "code` text",
      " continues",
    ]) {
      await stream.delta(delta);
    }
    // Every delta that opens or closes a fence or span reconciles; text between them appends.
    expect(stream.fast).toEqual([false, false, true, true, false, false, false, true]);
  });

  it.each(phases)("reconciles a fence marker held across deltas (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of ["<final>Intro\n", "``", "`js\n", "let x;\n", "```\n", "Outro"]) {
      await stream.delta(delta);
    }
    expect(stream.fast.slice(0, 3)).toEqual([false, false, false]);
  });

  it.each(phases)("reconciles reply directives split across deltas (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of ["<final>Hello [[reply_", "to_current]] there", " friend", " and more"]) {
      await stream.delta(delta);
    }
    // Once a directive was extracted the prepared text is no longer the stripped source.
    expect(stream.fast).toEqual([false, false, false, false]);
  });

  it.each(phases)("reconciles possible MEDIA lines (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of ["<final>Intro", "\nM", "EDIA: /tmp/a.png", "\nmore", " text", " tail"]) {
      await stream.delta(delta);
    }
    expect(stream.fast.slice(1, 3)).toEqual([false, false]);
  });

  it.each(phases)(
    "reconciles a MEDIA token completed later on its line (phase %s)",
    async (phase) => {
      const stream = createTaggedStream(phase);
      // The token has no payload yet, so its line is unchanged until the path arrives.
      for (const delta of [
        "<final>Here is the file MEDIA: ",
        "https://example.com/a.png",
        " later",
        " tail",
      ]) {
        await stream.delta(delta);
      }
      expect(stream.fast).toEqual([false, false, false, false]);

      const split = createTaggedStream(phase);
      for (const delta of ["<final>Look at the media", ": ", "/tmp/a.png", " end"]) {
        await split.delta(delta);
      }
      expect(split.fast).toEqual([false, false, false, false]);
    },
  );

  it.each(phases)("appends words starting with m mid-line (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of ["<final>Some text", " more", " words", " make", " Many"]) {
      await stream.delta(delta);
    }
    expect(stream.fast).toEqual([false, true, true, true, true]);
  });

  it.each(phases)("reconciles tool-call XML (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of [
      "<final>Intro ",
      '<tool_call>{"name":"x"}',
      "</tool_call>",
      " after text",
      " and more",
    ]) {
      await stream.delta(delta);
    }
    expect(stream.fast).toEqual([false, false, false, false, false]);
  });

  it.each(phases)("reconciles an unclosed function_calls payload (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of [
      "<final>Intro ",
      '<function_calls><invoke name="x">',
      "payload text",
      " more payload",
    ]) {
      await stream.delta(delta);
    }
    expect(stream.fast).toEqual([false, false, false, false]);
  });

  const orphanCloseTags = [
    "</think>",
    "</thinking>",
    "</thought>",
    "</antml:thinking>",
    "</mm:thought>",
    "</antthinking>",
    "< / think >",
  ];

  it.each(phases)(
    "reconciles text appended after an orphan reasoning close (phase %s)",
    async (phase) => {
      for (const closeTag of orphanCloseTags) {
        for (const space of ["", " ", "\n"]) {
          const stream = createTaggedStream(phase);
          await stream.delta(`<final>Hello world.${closeTag}${space}`);
          // The close is the tail of the source: once text follows it, canonical processing
          // drops everything before it, so the append must not extend the earlier block text.
          await stream.delta(" word");
          expect(stream.fast).toEqual([false, false]);
          expect(stream.ctx.blockChunker.bufferedText).not.toBe("Hello world. word");
          await stream.delta(" and more");
          expect(stream.fast).toEqual([false, false, false]);
        }
      }
    },
  );

  it.each(phases)(
    "matches canonical text after a reasoning close that text already follows (phase %s)",
    async (phase) => {
      const stream = createTaggedStream(phase);
      // The delta helper compares every step with a canonical snapshot.
      for (const delta of ["<final>Hello world.</think> then", " more", " words"]) {
        await stream.delta(delta);
      }
    },
  );

  it.each(phases)(
    "matches canonical reconciliation after mid-stream block drains (phase %s)",
    async (phase) => {
      const chunking: BlockReplyChunking = {
        minChars: 20,
        maxChars: 80,
        breakPreference: "sentence",
      };
      const stream = createTaggedStream(phase, chunking);
      const { ctx } = stream;
      const emitted: Array<{ text: string; metadata?: Partial<BlockChunkMetadata> }> = [];
      const emitBlockChunk = ctx.emitBlockChunk;
      ctx.emitBlockChunk = (text, options) => {
        emitted.push({
          text,
          metadata: {
            sourceText: options?.sourceText,
            sourceStart: options?.sourceStart,
            sourceEnd: options?.sourceEnd,
            reconciledSourceBreak: options?.reconciledSourceBreak,
          },
        });
        return emitBlockChunk(text, options);
      };
      // The reference replaces its pending source with each canonical snapshot and drains.
      const reference = new EmbeddedBlockChunker(chunking);
      const referenceEmitted: typeof emitted = [];
      const drainReference = (force: boolean) =>
        reference.drain({
          force,
          emit: (text, metadata) => {
            referenceEmitted.push({
              text,
              metadata: {
                sourceText: metadata?.sourceText,
                sourceStart: metadata?.sourceStart,
                sourceEnd: metadata?.sourceEnd,
                reconciledSourceBreak: metadata?.reconciledSourceBreak,
              },
            });
          },
        });

      const consumedAfterDelta: number[] = [];
      for (const delta of [
        "<final>The first sentence ends here.",
        " Then a second one keeps going",
        " for a while longer.",
        " A third arrives now",
        " without any markup",
        " in the middle.",
        " And a closing tail",
        " of plain words",
      ]) {
        await stream.delta(delta);
        reference.replace(stream.canonicalBlockText(0, false), 0, true);
        drainReference(false);
        consumedAfterDelta.push(ctx.blockChunker.consumedLength);
        expect(ctx.blockChunker.consumedLength).toBe(reference.consumedLength);
        expect(ctx.blockChunker.bufferedText).toBe(reference.bufferedText);
        expect(ctx.blockChunker.preparedSourceBreaks).toEqual(reference.preparedSourceBreaks);
        expect(emitted).toEqual(referenceEmitted);
      }
      // Appends ran after text had already been consumed.
      const firstConsumed = consumedAfterDelta.findIndex((consumed) => consumed > 0);
      expect(firstConsumed).toBeGreaterThanOrEqual(0);
      expect(stream.fast.slice(firstConsumed + 1).some(Boolean)).toBe(true);

      await ctx.flushBlockReplyBuffer({ final: true });
      drainReference(true);
      expect(ctx.blockChunker.consumedLength).toBe(reference.consumedLength);
      const delivered = stream.onBlockReply.mock.calls.map(([payload]) => payload.text);
      expect(delivered).toEqual(referenceEmitted.map(({ text }) => text.trimEnd()));
      expect(delivered.join("")).toBe(
        "The first sentence ends here. Then a second one keeps going for a while longer. A third arrives now without any markup in the middle. And a closing tail of plain words",
      );
    },
  );

  it.each(phases)("reconciles a corrected text_end snapshot (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    for (const delta of ["<final>Draft answer", " text here", " continues"]) {
      await stream.delta(delta);
    }
    expect(stream.fast).toEqual([false, true, true]);
    await stream.textEnd("<final>Corrected answer</final>");
    expect(stream.ctx.blockChunker.bufferedText).toBe("Corrected answer");
  });

  it.each(phases)("reconciles a second content part (phase %s)", async (phase) => {
    const stream = createTaggedStream(phase);
    await stream.delta("<final>First part", 0);
    await stream.delta(" text", 0);
    await stream.delta("Second part", 1);
    await stream.delta(" more text", 1);
    await stream.delta(" and more", 1);
    // Phase-aware streams reset the incremental tag state at the block boundary, so the
    // second block never matches its canonical snapshot's tag state and stays on that path.
    expect(stream.fast).toEqual(
      phase ? [false, true, false, false, false] : [false, true, false, true, true],
    );
    expect(stream.ctx.blockChunker.bufferedText).toBe(
      phase ? "Second part more text and more" : "First part text\nSecond part more text and more",
    );
  });

  it.each(phases)("matches the canonical block reply at message_end (phase %s)", async (phase) => {
    const deltas = ["<final>Hello wor", "ld, this is", " a plain stream", " that ends.</final>"];
    const text = deltas.join("");
    const streamed = createTaggedStream(phase);
    for (const delta of deltas) {
      await streamed.delta(delta);
    }
    const whole = createTaggedStream(phase);
    await whole.delta(text);
    await streamed.textEnd(text);
    await whole.textEnd(text);
    const finalMessage = {
      role: "assistant",
      ...(phase ? { phase } : {}),
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: { input: 1, output: 1, total: 2 },
    };
    await endMessage(streamed.ctx, { message: finalMessage });
    await endMessage(whole.ctx, { message: finalMessage });

    const texts = (mock: ReturnType<typeof vi.fn>) =>
      mock.mock.calls.map(([payload]) => (payload as { text: string }).text);
    expect(texts(streamed.onBlockReply)).toEqual([
      "Hello world, this is a plain stream that ends.",
    ]);
    expect(texts(streamed.onBlockReply)).toEqual(texts(whole.onBlockReply));
  });

  it("does work proportional to the streamed text, unlike canonical reconciliation", async () => {
    const measure = async (chars: number, delta: string) => {
      const stream = createTaggedStream("final_answer");
      await stream.delta("<final>");
      await stream.delta("start");
      for (let at = 0; at < chars; at += delta.length) {
        await stream.delta(delta);
      }
      return stream.stripChars;
    };
    const plain = "lorem ip";
    // A tilde forces every delta through the canonical full-snapshot path.
    const canonical = "lorem i~";

    const plainSmall = await measure(2_000, plain);
    const plainLarge = await measure(4_000, plain);
    const canonicalSmall = await measure(2_000, canonical);
    const canonicalLarge = await measure(4_000, canonical);

    // Fast path: each chunk is stripped once, so work tracks the streamed text.
    expect(plainLarge).toBeLessThanOrEqual(4_000 + 64);
    expect(plainLarge / plainSmall).toBeLessThan(2.2);
    // Canonical path: every delta strips the accumulated prefix again.
    expect(canonicalSmall).toBeGreaterThan(2_000 * 20);
    expect(canonicalLarge / canonicalSmall).toBeGreaterThan(3.5);
  });
});
