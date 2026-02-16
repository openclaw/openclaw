import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  extractAgentEventPayloads,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
  const THINKING_TAG_CASES = [
    { tag: "think", open: "<think>", close: "</think>" },
    { tag: "thinking", open: "<thinking>", close: "</thinking>" },
    { tag: "thought", open: "<thought>", close: "</thought>" },
    { tag: "antthinking", open: "<antthinking>", close: "</antthinking>" },
  ] as const;

  it.each(THINKING_TAG_CASES)(
    "streams <%s> reasoning via onReasoningStream without leaking into final text",
    ({ open, close }) => {
      let handler: ((evt: unknown) => void) | undefined;
      const session: StubSession = {
        subscribe: (fn) => {
          handler = fn;
          return () => {};
        },
      };

      const onReasoningStream = vi.fn();
      const onBlockReply = vi.fn();

      subscribeEmbeddedPiSession({
        session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
        runId: "run",
        onReasoningStream,
        onBlockReply,
        blockReplyBreak: "message_end",
        reasoningMode: "stream",
      });

      handler?.({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta: `${open}\nBecause`,
        },
      });

      handler?.({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta: ` it helps\n${close}\n\nFinal answer`,
        },
      });

      const assistantMessage = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${open}\nBecause it helps\n${close}\n\nFinal answer`,
          },
        ],
      } as AssistantMessage;

      handler?.({ type: "message_end", message: assistantMessage });

      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(onBlockReply.mock.calls[0][0].text).toBe("Final answer");

      const streamTexts = onReasoningStream.mock.calls
        .map((call) => call[0]?.text)
        .filter((value): value is string => typeof value === "string");
      expect(streamTexts.at(-1)).toBe("Reasoning:\n_Because it helps_");

      expect(assistantMessage.content).toEqual([
        { type: "thinking", thinking: "Because it helps" },
        { type: "text", text: "Final answer" },
      ]);
    },
  );
  it.each(THINKING_TAG_CASES)(
    "suppresses <%s> blocks across chunk boundaries",
    ({ open, close }) => {
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
        blockReplyBreak: "text_end",
        blockReplyChunking: {
          minChars: 5,
          maxChars: 50,
          breakPreference: "newline",
        },
      });

      handler?.({ type: "message_start", message: { role: "assistant" } });

      handler?.({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta: `${open}Reasoning chunk that should not leak`,
        },
      });

      expect(onBlockReply).not.toHaveBeenCalled();

      handler?.({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta: `${close}\n\nFinal answer`,
        },
      });

      handler?.({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_end" },
      });

      const payloadTexts = onBlockReply.mock.calls
        .map((call) => call[0]?.text)
        .filter((value): value is string => typeof value === "string");
      expect(payloadTexts.length).toBeGreaterThan(0);
      for (const text of payloadTexts) {
        expect(text).not.toContain("Reasoning");
        expect(text).not.toContain(open);
      }
      const combined = payloadTexts.join(" ").replace(/\s+/g, " ").trim();
      expect(combined).toBe("Final answer");
    },
  );

  it("emits delta chunks in agent events for streaming assistant text", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onAgentEvent,
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });

    const payloads = onAgentEvent.mock.calls
      .map((call) => call[0]?.data as Record<string, unknown> | undefined)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    expect(payloads[0]?.text).toBe("Hello");
    expect(payloads[0]?.delta).toBe("Hello");
    expect(payloads[1]?.text).toBe("Hello world");
    expect(payloads[1]?.delta).toBe(" world");
  });

  it("emits agent events on message_end for non-streaming assistant text", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onAgentEvent,
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Hello world");
    expect(payloads[0]?.delta).toBe("Hello world");
  });

  it("does not emit duplicate agent events when message_end repeats", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onAgentEvent,
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    handler?.({ type: "message_start", message: assistantMessage });
    handler?.({ type: "message_end", message: assistantMessage });
    handler?.({ type: "message_end", message: assistantMessage });

    const payloads = onAgentEvent.mock.calls
      .map((call) => call[0]?.data as Record<string, unknown> | undefined)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    expect(payloads).toHaveLength(1);
  });

  it("skips agent events when cleaned text rewinds mid-stream", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onAgentEvent,
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "MEDIA:" },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: " https://example.com/a.png\nCaption" },
    });

    const payloads = onAgentEvent.mock.calls
      .map((call) => call[0]?.data as Record<string, unknown> | undefined)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("MEDIA:");
  });

  it("emits agent events when media arrives without text", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onAgentEvent,
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "MEDIA: https://example.com/a.png" },
    });

    const payloads = onAgentEvent.mock.calls
      .map((call) => call[0]?.data as Record<string, unknown> | undefined)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("");
    expect(payloads[0]?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("keeps unresolved mutating failure when an unrelated tool succeeds", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-tools-1",
      sessionKey: "test-session",
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/demo.txt", content: "next" },
    });
    handler?.({
      type: "tool_execution_end",
      toolName: "write",
      toolCallId: "w1",
      isError: true,
      result: { error: "disk full" },
    });
    expect(subscription.getLastToolError()?.toolName).toBe("write");

    handler?.({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "r1",
      args: { path: "/tmp/demo.txt" },
    });
    handler?.({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "r1",
      isError: false,
      result: { text: "ok" },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("clears unresolved mutating failure when the same action succeeds", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-tools-2",
      sessionKey: "test-session",
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/demo.txt", content: "next" },
    });
    handler?.({
      type: "tool_execution_end",
      toolName: "write",
      toolCallId: "w1",
      isError: true,
      result: { error: "disk full" },
    });
    expect(subscription.getLastToolError()?.toolName).toBe("write");

    handler?.({
      type: "tool_execution_start",
      toolName: "write",
      toolCallId: "w2",
      args: { path: "/tmp/demo.txt", content: "retry" },
    });
    handler?.({
      type: "tool_execution_end",
      toolName: "write",
      toolCallId: "w2",
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()).toBeUndefined();
  });

  it("keeps unresolved mutating failure when same tool succeeds on a different target", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-tools-3",
      sessionKey: "test-session",
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/a.txt", content: "first" },
    });
    handler?.({
      type: "tool_execution_end",
      toolName: "write",
      toolCallId: "w1",
      isError: true,
      result: { error: "disk full" },
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "write",
      toolCallId: "w2",
      args: { path: "/tmp/b.txt", content: "second" },
    });
    handler?.({
      type: "tool_execution_end",
      toolName: "write",
      toolCallId: "w2",
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("keeps unresolved session_status model-mutation failure on later read-only status success", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-tools-4",
      sessionKey: "test-session",
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "session_status",
      toolCallId: "s1",
      args: { sessionKey: "agent:main:main", model: "openai/gpt-4o" },
    });
    handler?.({
      type: "tool_execution_end",
      toolName: "session_status",
      toolCallId: "s1",
      isError: true,
      result: { error: "Model not allowed." },
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "session_status",
      toolCallId: "s2",
      args: { sessionKey: "agent:main:main" },
    });
    handler?.({
      type: "tool_execution_end",
      toolName: "session_status",
      toolCallId: "s2",
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("session_status");
  });

  it("emits lifecycle:error event on agent_end when last assistant message was an error", async () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-error",
      onAgentEvent,
      sessionKey: "test-session",
    });

    const assistantMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "429 Rate limit exceeded",
    } as AssistantMessage;

    // Simulate message update to set lastAssistant
    handler?.({ type: "message_update", message: assistantMessage });

    // Trigger agent_end
    handler?.({ type: "agent_end" });

    // Look for lifecycle:error event
    const lifecycleError = onAgentEvent.mock.calls.find(
      (call) => call[0]?.stream === "lifecycle" && call[0]?.data?.phase === "error",
    );

    expect(lifecycleError).toBeDefined();
    expect(lifecycleError[0].data.error).toContain("API rate limit reached");
  });
});
