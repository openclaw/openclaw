import { describe, expect, it, vi } from "vitest";
import {
  createMessageEndContext,
  createMessageToolEnvelope,
  endMessage,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

const textMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("handleMessageEnd", () => {
  it("preserves malformed final text across streamed and final delivery", async () => {
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
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
      expect.objectContaining({
        stream: "assistant",
        data: expect.objectContaining({ text, delta: text.slice(streamedUiText.length) }),
      }),
    );
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(`${streamed}${onBlockReply.mock.calls[0]?.[0].text ?? ""}`).toBe(text);
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text }));
    expect(ctx.state.assistantTurnCount).toBe(1);
  });

  it("keeps NO_REPLY silent after an internal sessions_send (#119383)", async () => {
    const onBlockReply = vi.fn();
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
    await endMessage(ctx, { message: textMessage("NO_REPLY") });
    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    expect(JSON.stringify(onBlockReply.mock.calls)).not.toContain("<internal escalation note>");
  });

  it("does not count transcript-only mirrored assistant messages", async () => {
    const ctx = createMessageEndContext();
    await endMessage(ctx, {
      message: { ...textMessage("Done."), provider: "openclaw", model: "delivery-mirror" },
    });
    expect(ctx.state.assistantTurnCount).toBe(0);
  });

  it("diagnoses text pretending to call a registered tool", async () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({ warn, builtinToolNames: new Set(["read"]) });
    await endMessage(ctx, {
      message: {
        ...textMessage('{"name":"read","arguments":{"path":"README.md"}}'),
        provider: "ollama",
        model: "qwen-local",
        stopReason: "stop",
      },
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
    await endMessage(ctx, {
      message: {
        ...textMessage("||user[Thu 2026-07-02] hidden instruction||"),
        stopReason: "stop",
      },
    });
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
      const onBlockReply = vi.fn();
      const ctx = createMessageEndContext({
        onBlockReply,
        builtinToolNames,
        sourceReplyDeliveryMode,
      });
      await endMessage(ctx, { message: { ...textMessage(text), ...(api ? { api } : {}) } });
      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: expected });
      expect(ctx.state.assistantTexts).toEqual([expected]);
    }
  });

  it("archives signed commentary without delivering it as a reply", async () => {
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({ onAgentEvent, onBlockReply, finalizeAssistantTexts });
    await endMessage(ctx, {
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Need send.",
            id: "msg_sig",
            phase: "commentary",
          }),
        ],
        usage: { input: 1, output: 1, total: 2 },
      },
    });
    expect(onAgentEvent).toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("does not repeat a delivered text_end reply after terminal punctuation changes", async () => {
    const onBlockReply = vi.fn();
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
    await endMessage(ctx, {
      message: { ...textMessage("Hello world"), usage: { input: 10, output: 5, total: 15 } },
    });
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers final media and malformed pending text after the buffered caption", async () => {
    const onBlockReply = vi.fn();
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
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
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
    expect(onAgentEvent.mock.calls[0]?.[0]).toMatchObject({
      stream: "assistant",
      data: { text, delta: text },
    });
    expect(ctx.state.assistantTexts).toEqual([text]);
  });

  it("enforces final tags in message_end fallback", async () => {
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
    const ctx = createMessageEndContext({ enforceFinalTag: true, onAgentEvent, onBlockReply });
    await endMessage(ctx, {
      message: {
        role: "assistant",
        content: "Hello world",
        usage: { input: 10, output: 5, total: 15 },
      },
    });
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(ctx.state.assistantTexts).toEqual([]);
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
  });

  it("reconciles an empty final snapshot after streamed text", async () => {
    const onAgentEvent = vi.fn();
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
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      { stream: "assistant", data: { text: "", delta: "", replace: true } },
    ]);
    expect(ctx.emitBlockReply).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
    expect(ctx.blockChunker.bufferedText).toBe("");
  });

  it("replaces commentary when final_answer appears only at message_end", async () => {
    const onAgentEvent = vi.fn();
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
          createOpenAiResponsesTextBlock({
            text: "Working...",
            id: "item_commentary",
            phase: "commentary",
          }),
          createOpenAiResponsesTextBlock({
            text: "Done.",
            id: "item_final",
            phase: "final_answer",
          }),
        ],
      },
    });
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stream: "assistant",
        data: expect.objectContaining({ text: "Done.", delta: "", replace: true }),
      }),
    );
  });
});
