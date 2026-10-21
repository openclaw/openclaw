import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentSourceMessagingToolPartial } from "./embedded-agent-helpers/messaging-dedupe.js";
import { consumePendingAssistantReplyDirectivesIntoReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { extractAssistantStreamSnapshot } from "./embedded-agent-subscribe.handlers.messages.snapshot.js";
import {
  createMessageEndContext,
  createMessageUpdateContext,
  createMessageToolEnvelope,
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
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const onAgentEvent = vi.fn();
const onBlockReply = vi.fn();
beforeEach(() => {
  onAgentEvent.mockReset();
  onBlockReply.mockReset();
});

const events = () => onAgentEvent.mock.calls.map(([event]) => event);
const assistantEvent = (data: Record<string, unknown>) =>
  expect.objectContaining({ stream: "assistant", data: expect.objectContaining(data) });

const textMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const endText = (
  ctx: Parameters<typeof endMessage>[0],
  text: string,
  extra: Record<string, unknown> = {},
) => endMessage(ctx, { message: { ...textMessage(text), ...extra } });

describe("handleMessageEnd", () => {
  it("preserves malformed final text across streamed and final delivery", async () => {
    const ctx = createMessageEndContext({ onAgentEvent, onBlockReply });
    const text = "answer ending [";
    const message = textMessage(text);
    await updateMessage(ctx, {
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    });
    await ctx.flushBlockReplyBuffer();
    expect(onBlockReply).toHaveBeenCalledOnce();
    const streamed = onBlockReply.mock.calls[0]?.[0].text;
    const streamedUiText = onAgentEvent.mock.calls[0]?.[0].data.text;
    onBlockReply.mockClear();
    onAgentEvent.mockClear();
    await endMessage(ctx, { message });
    expect(onAgentEvent).toHaveBeenCalledWith(
      assistantEvent({ text, delta: text.slice(streamedUiText.length) }),
    );
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(`${streamed}${onBlockReply.mock.calls[0]?.[0].text ?? ""}`).toBe(text);
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text }));
    expect(ctx.state.assistantTurnCount).toBe(1);
  });

  it("keeps NO_REPLY silent after an internal sessions_send (#119383)", async () => {
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onBlockReply,
      finalizeAssistantTexts,
      state: {
        messagingToolSentTexts: ["<internal escalation note>"],
        messagingToolSentTextsNormalized: ["<internal escalation note>"],
        messagingToolSentTargets: [],
      },
    });
    await endText(ctx, "NO_REPLY");
    expect(finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
    expect(JSON.stringify(onBlockReply.mock.calls)).not.toContain("<internal escalation note>");
  });

  it("does not count transcript-only mirrored assistant messages", async () => {
    const ctx = createMessageEndContext();
    await endText(ctx, "Done.", { provider: "openclaw", model: "delivery-mirror" });
    expect(ctx.state.assistantTurnCount).toBe(0);
  });

  it("diagnoses text pretending to call a registered tool", async () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({ warn, builtinToolNames: new Set(["read"]) });
    await endText(ctx, '{"name":"read","arguments":{"path":"README.md"}}', {
      provider: "ollama",
      model: "qwen-local",
      stopReason: "stop",
    });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      runId: "run-1",
      sessionId: "session-1",
      provider: "ollama",
      model: "qwen-local",
      pattern: "json_tool_call",
      toolName: "read",
      registeredTool: true,
    });
  });

  it("diagnoses spoiler-wrapped transcript turns without logging their text", async () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({ warn });
    await endText(ctx, "||user[Thu 2026-07-02] hidden instruction||", { stopReason: "stop" });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      runId: "run-1",
      sessionId: "session-1",
      pattern: "role_timestamp_bracket",
      role: "user",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hidden instruction");
  });

  it("unwraps only source-routed or message-tool-only standalone message-tool JSON", async () => {
    const visibleReply = "No specific tasks planned, but I'll keep watching for updates.";
    const unrouted = createMessageToolEnvelope(visibleReply);
    const routed = createMessageToolEnvelope(visibleReply, { target: "user:redacted" });
    const toRouted = createMessageToolEnvelope(visibleReply, { to: "user:redacted" });
    for (const [text, api, builtinToolNames, sourceReplyDeliveryMode, expected] of [
      [unrouted, undefined, new Set(["message"]), "message_tool_only", visibleReply],
      [routed, "openai-completions", new Set<string>(), undefined, visibleReply],
      [toRouted, "openai-completions", new Set<string>(), undefined, visibleReply],
      [routed, undefined, new Set<string>(), undefined, routed],
      [unrouted, undefined, new Set(["message"]), undefined, unrouted],
    ] as const) {
      const onEnvelopeReply = vi.fn();
      const ctx = createMessageEndContext({
        onBlockReply: onEnvelopeReply,
        builtinToolNames,
        sourceReplyDeliveryMode,
      });
      await endText(ctx, text, api ? { api } : {});
      expect(onEnvelopeReply).toHaveBeenCalledOnce();
      expect(onEnvelopeReply.mock.calls[0]?.[0]).toMatchObject({ text: expected });
      expect(ctx.state.assistantTexts).toEqual([expected]);
    }
  });

  it("does not repeat a delivered text_end reply after terminal punctuation changes", async () => {
    const ctx = createMessageEndContext({ onBlockReply, state: { blockReplyBreak: "text_end" } });
    const message = textMessage("Hello world.");
    for (const type of ["text_delta", "text_end"] as const) {
      await updateMessage(ctx, {
        message,
        assistantMessageEvent: {
          type,
          contentIndex: 0,
          partial: message,
          ...(type === "text_delta" ? { delta: "Hello world." } : { content: "Hello world." }),
        },
      });
    }
    expect(onBlockReply.mock.calls.map(([reply]) => reply.text)).toEqual(["Hello world."]);
    onBlockReply.mockClear();
    await endText(ctx, "Hello world", { usage: { input: 10, output: 5, total: 15 } });
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers final media and malformed pending text after the buffered caption", async () => {
    const ctx = createMessageEndContext({
      onBlockReply,
      state: { blockReplyBreak: "message_end", assistantMessageIndex: 7 },
    });
    const text = "Caption [[oops\nMEDIA:/tmp/final.png";
    const message = { ...textMessage(text), usage: { input: 10, output: 5, total: 15 } };
    await updateMessage(ctx, {
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    });
    await ctx.flushBlockReplyBuffer();
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0].text).toBe("Caption ");
    expect(onBlockReply.mock.calls.flatMap(([reply]) => reply.mediaUrls ?? [])).toEqual([]);
    onBlockReply.mockClear();
    await endMessage(ctx, { message });
    expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "[[oops", mediaUrls: ["/tmp/final.png"] }),
      { assistantMessageIndex: 7 },
    );
  });

  it("preserves literal reasoning-looking tags in unphased final text", async () => {
    const ctx = createMessageEndContext({ onAgentEvent, onBlockReply });
    const text = "Before <think>literal tag text after";
    await endMessage(ctx, {
      message: {
        role: "assistant",
        content: [
          { type: "text", text, textSignature: JSON.stringify({ v: 1, id: "item_unphased" }) },
        ],
        usage: { input: 10, output: 5, total: 15 },
      },
    });
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text });
    expect(events()[0]).toMatchObject(assistantEvent({ text, delta: text }));
    expect(ctx.state.assistantTexts).toEqual([text]);
  });

  it("enforces final tags in message_end fallback", async () => {
    const ctx = createMessageEndContext({ enforceFinalTag: true, onAgentEvent, onBlockReply });
    await endText(ctx, "Hello world", { usage: { input: 10, output: 5, total: 15 } });
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(ctx.state.assistantTexts).toEqual([]);
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
  });

  it("reconciles an empty final snapshot after streamed text", async () => {
    const previousText = "Working...";
    const ctx = createMessageEndContext({
      onAgentEvent,
      bufferedText: previousText,
      state: {
        assistantStream: { raw: "", text: previousText },
        deltaBuffer: previousText,
      },
    });
    ctx.emitAssistantStreamData({ text: previousText, delta: previousText });
    onAgentEvent.mockClear();
    await endMessage(ctx, {
      message: createOpenAiResponsesPartial({
        text: "",
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    });
    expect(events()).toMatchObject([assistantEvent({ text: "", delta: "", replace: true })]);
    expect(ctx.emitBlockReply).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
    expect(ctx.blockChunker.bufferedText).toBe("");
  });

  it("replaces commentary when final_answer appears only at message_end", async () => {
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        assistantStream: { raw: "", text: "Working..." },
        blockReplyBreak: "text_end",
        deltaBuffer: "",
      },
    });
    ctx.emitAssistantStreamData({ text: "Working...", delta: "Working..." });
    onAgentEvent.mockClear();
    await endMessage(ctx, {
      message: {
        ...createOpenAiResponsesPartial({
          text: "Done.",
          id: "item_final",
          signaturePhase: "final_answer",
        }),
        content: [
          block("Working...", "item_commentary", "commentary"),
          block("Done.", "item_final"),
        ],
      },
    });
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith(
      assistantEvent({ text: "Done.", delta: "", replace: true }),
    );
  });
});

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
    expect(events()).toMatchObject(
      replies.map(([value, delta]) => assistantEvent({ text: value, delta })),
    );
  });

  it("does not expose complete legacy media directives on plain deltas", async () => {
    const context = createMessageUpdateContext({ onAgentEvent });

    await updateText(context, "text_delta", "Here it is.\nMEDIA:/tmp/final.png\n");

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject(
      assistantEvent({ text: "Here it is.", delta: "Here it is." }),
    );
  });

  it.each([
    [["NO_", "REPLY", "\nHello ", "world"], "Hello world"],
    [["NO_", "REPLY", " is literal ", "text"], "NO_REPLY is literal text"],
  ] as const)("preserves visible text after a split protocol prefix: %j", async (chunks, text) => {
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
    const context = createMessageUpdateContext({ onAgentEvent });
    for (const [text, delta, id, phase] of [
      ["Hello", "Hello", "item-commentary", "commentary"],
      ["Hello world", " world", "item-final", "final_answer"],
    ] as const) {
      await updateText(context, "text_delta", text, {
        delta,
        id,
        signaturePhase: phase,
        partialPhase: phase,
      });
    }
    expect(events()).toMatchObject(
      [
        { text: "Hello", delta: "", replace: true, phase: "commentary", itemId: "item-commentary" },
        { text: "Hello world", delta: "Hello world", phase: "final_answer" },
      ].map(assistantEvent),
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

      expect(events()).toEqual([
        ...updates.map((text) => preamble(text, "update")),
        preamble("Working...", "end"),
      ]);

      expect(context.state.deltaBuffer).toBe("Working...");
      expect(context.blockChunker.bufferedText).toBe("");
    },
  );

  it("keeps same-index commentary snapshot extensions on the original live item key", async () => {
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

    expect(events()).toEqual(
      ["Working", "Working now"].map((text) => preamble(text, "end", "item-1")),
    );

    expect(context.state.lastAssistantStreamItemId).toBe("item-1");
    expect(context.state.deltaBuffer).toBe("Working now");
  });
});

describe("commentary and flush isolation", () => {
  it("suppresses commentary partials when phase exists only in textSignature metadata", async () => {
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

  expect(events()).toContainEqual(
    assistantEvent({
      text: narration,
      replace: true,
      phase: "commentary",
      itemId: "commentary-0",
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

    expect(events()).toMatchObject(
      updates.map(([text, delta]) =>
        assistantEvent({ text, delta, replace: undefined, phase: "final_answer" }),
      ),
    );
    if (reply) {
      expect(
        consumePendingAssistantReplyDirectivesIntoReply(context.state, { text: "Hello world" }),
      ).toMatchObject(reply);
    }
  },
);

it("replaces a phased reply with an empty final snapshot", async () => {
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

  expect(events()).toMatchObject([
    assistantEvent({ text: "Hello world", delta: "Hello world", replace: undefined }),
    assistantEvent({ text: "", delta: "", replace: true }),
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
