import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession", () => {
  it("deduplicates assistant text repeated after tool_use round-trip (text_end mode)", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-dedup-tool-roundtrip",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    // --- Assistant message 1: text + tool_use ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Here is my response!",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", content: "Here is my response!" },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // Tool use + tool result round-trip
    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-1",
      args: { command: "set-conversation-state.sh" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-1",
      result: "OK",
    });

    // --- Assistant message 2: model repeats same text ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Here is my response!",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", content: "Here is my response!" },
    });

    // The duplicate text should NOT produce a second block reply
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Here is my response!"]);
  });

  it("deduplicates assistant text repeated after tool_use round-trip (message_end mode)", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-dedup-msg-end",
    });

    // --- Assistant message 1: text + tool_use ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    const msg1 = {
      role: "assistant",
      content: [{ type: "text", text: "Hello from the assistant!" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: msg1 });

    // Tool round-trip
    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-2",
      args: { command: "set-mood.sh" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-2",
      result: "OK",
    });

    // --- Assistant message 2: model repeats same text ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    const msg2 = {
      role: "assistant",
      content: [{ type: "text", text: "Hello from the assistant!" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: msg2 });

    expect(subscription.assistantTexts).toEqual(["Hello from the assistant!"]);
  });

  it("allows different text after tool_use round-trip", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-dedup-different",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    // --- Assistant message 1 ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "First response" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", content: "First response" },
    });

    // Tool round-trip
    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-3",
      args: { command: "echo test" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-3",
      result: "test",
    });

    // --- Assistant message 2: DIFFERENT text ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Follow-up response" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", content: "Follow-up response" },
    });

    // Different text should still be delivered
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(subscription.assistantTexts).toEqual(["First response", "Follow-up response"]);
  });

  it("deduplicates with block chunking enabled (text_end mode)", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-dedup-chunking",
      onBlockReply,
      blockReplyBreak: "text_end",
      // Use chunk sizes larger than the test message so all text stays in the
      // chunker buffer until the forced text_end drain — this exercises the
      // full-message dedup path that fires before chunking occurs.
      blockReplyChunking: { minChars: 50, maxChars: 200 },
    });

    // --- Assistant message 1 ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Chunked response!" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", content: "Chunked response!" },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // Tool round-trip
    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-chunk-1",
      args: { command: "echo ok" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-chunk-1",
      result: "ok",
    });

    // --- Assistant message 2: model repeats same text ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Chunked response!" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end", content: "Chunked response!" },
    });

    // Duplicate should be suppressed even with chunking active
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Chunked response!"]);
  });

  it("deduplicates with block chunking enabled (message_end mode)", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-dedup-chunking-msg-end",
      onBlockReply,
      blockReplyBreak: "message_end",
      blockReplyChunking: { minChars: 50, maxChars: 200 },
    });

    // --- Assistant message 1 ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    const msg1 = {
      role: "assistant",
      content: [{ type: "text", text: "Chunked message_end response!" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: msg1 });

    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // Tool round-trip
    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-chunk-msg-1",
      args: { command: "echo ok" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-chunk-msg-1",
      result: "ok",
    });

    // --- Assistant message 2: model repeats same text ---
    handler?.({ type: "message_start", message: { role: "assistant" } });

    const msg2 = {
      role: "assistant",
      content: [{ type: "text", text: "Chunked message_end response!" }],
    } as AssistantMessage;

    handler?.({ type: "message_end", message: msg2 });

    // Duplicate should be suppressed even with chunking active
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Chunked message_end response!"]);
  });
});
