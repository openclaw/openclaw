import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession forcePrependThinkTag", () => {
  it("prepends <think> tag to first delta when forcePrependThinkTag is enabled", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      forcePrependThinkTag: true,
    });

    const assistantMessage = {
      role: "assistant",
      content: [] as Array<{ type: string; text?: string }>,
    };

    // Simulate message_start
    handler?.({ type: "message_start", message: assistantMessage });

    // Simulate text_delta events (model output without <think> tag)
    handler?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", delta: "My reasoning here" },
    });
    handler?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", delta: "</think>\n\nFinal answer" },
    });

    // Simulate message_end
    (assistantMessage.content as Array<{ type: string; text?: string }>).push({
      type: "text",
      text: "<think>My reasoning here</think>\n\nFinal answer",
    });
    handler?.({ type: "message_end", message: assistantMessage });

    // Verify block reply was called
    expect(onBlockReply).toHaveBeenCalled();
    // The final text should have <think> prepended (which gets stripped by the tag processor)
    // The important thing is that the reasoning was captured
    const lastCall = onBlockReply.mock.calls[onBlockReply.mock.calls.length - 1][0];
    expect(lastCall.text).toBe("Final answer");
  });

  it("does not prepend <think> tag when forcePrependThinkTag is disabled", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      forcePrependThinkTag: false,
    });

    const assistantMessage = {
      role: "assistant",
      content: [] as Array<{ type: string; text?: string }>,
    };

    // Simulate message_start
    handler?.({ type: "message_start", message: assistantMessage });

    // Simulate text_delta events without think tags
    handler?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", delta: "Just a plain answer" },
    });

    // Simulate message_end
    (assistantMessage.content as Array<{ type: string; text?: string }>).push({
      type: "text",
      text: "Just a plain answer",
    });
    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalled();
    const lastCall = onBlockReply.mock.calls[onBlockReply.mock.calls.length - 1][0];
    expect(lastCall.text).toBe("Just a plain answer");
  });

  it("only prepends <think> tag once per assistant message", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      forcePrependThinkTag: true,
    });

    const assistantMessage = {
      role: "assistant",
      content: [] as Array<{ type: string; text?: string }>,
    };

    // First assistant message
    handler?.({ type: "message_start", message: assistantMessage });
    handler?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", delta: "First" },
    });
    handler?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", delta: " chunk" },
    });
    handler?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", delta: "</think>Answer" },
    });

    (assistantMessage.content as Array<{ type: string; text?: string }>).push({
      type: "text",
      text: "<think>First chunk</think>Answer",
    });
    handler?.({ type: "message_end", message: assistantMessage });

    // Second assistant message (after tool use, etc.)
    assistantMessage.content = [];
    handler?.({ type: "message_start", message: assistantMessage });
    handler?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", delta: "Second" },
    });
    handler?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", delta: "</think>Response" },
    });

    (assistantMessage.content as Array<{ type: string; text?: string }>).push({
      type: "text",
      text: "<think>Second</think>Response",
    });
    handler?.({ type: "message_end", message: assistantMessage });

    // Both messages should have had <think> prepended and processed correctly
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[0][0].text).toBe("Answer");
    expect(onBlockReply.mock.calls[1][0].text).toBe("Response");
  });
});
