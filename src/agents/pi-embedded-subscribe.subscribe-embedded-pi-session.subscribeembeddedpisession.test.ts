import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  THINKING_TAG_CASES,
  createStubSessionHarness,
  emitAssistantLifecycleErrorAndEnd,
  emitMessageStartAndEndForAssistantText,
  expectSingleAgentEventText,
  extractAgentEventPayloads,
  findLifecycleErrorAgentEvent,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
  function createAgentEventHarness(options?: { runId?: string; sessionKey?: string }) {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: options?.runId ?? "run",
      onAgentEvent,
      sessionKey: options?.sessionKey,
    });

    return { emit, onAgentEvent };
  }

  function createToolErrorHarness(runId: string) {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId,
      sessionKey: "test-session",
    });

    return { emit, subscription };
  }

  function emitToolRun(params: {
    emit: (evt: unknown) => void;
    toolName: string;
    toolCallId: string;
    args?: Record<string, unknown>;
    isError: boolean;
    result: unknown;
  }): void {
    params.emit({
      type: "tool_execution_start",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      args: params.args,
    });
    params.emit({
      type: "tool_execution_end",
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      isError: params.isError,
      result: params.result,
    });
  }

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

  it("streams native thinking_delta events and signals reasoning end", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream,
      onReasoningEnd,
    });

    handler?.({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Checking files" }],
      },
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Checking files",
      },
    });

    handler?.({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Checking files done" }],
      },
      assistantMessageEvent: {
        type: "thinking_end",
      },
    });

    const streamTexts = onReasoningStream.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(streamTexts.at(-1)).toBe("Reasoning:\n_Checking files done_");
    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it("emits reasoning end once when native and tagged reasoning end overlap", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onReasoningEnd = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      reasoningMode: "stream",
      onReasoningStream: vi.fn(),
      onReasoningEnd,
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "<think>Checking",
      },
    });

    handler?.({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Checking" }],
      },
      assistantMessageEvent: {
        type: "thinking_end",
      },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: " files</think>\nFinal answer",
      },
    });

    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it("emits delta chunks in agent events for streaming assistant text", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: " world" },
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
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
    emitMessageStartAndEndForAssistantText({ emit, text: "Hello world" });
    expectSingleAgentEventText(onAgentEvent.mock.calls, "Hello world");
  });

  it("does not emit duplicate agent events when message_end repeats", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
  });

  it("skips agent events when cleaned text rewinds mid-stream", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "MEDIA:" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: " https://example.com/a.png\nCaption" },
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("MEDIA:");
  });

  it("emits agent events when media arrives without text", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "MEDIA: https://example.com/a.png" },
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("");
    expect(payloads[0]?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("keeps unresolved mutating failure when an unrelated tool succeeds", () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-1");

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/demo.txt", content: "next" },
      isError: true,
      result: { error: "disk full" },
    });
    expect(subscription.getLastToolError()?.toolName).toBe("write");

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "r1",
      args: { path: "/tmp/demo.txt" },
      isError: false,
      result: { text: "ok" },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("clears unresolved mutating failure when the same action succeeds", () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-2");

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/demo.txt", content: "next" },
      isError: true,
      result: { error: "disk full" },
    });
    expect(subscription.getLastToolError()?.toolName).toBe("write");

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w2",
      args: { path: "/tmp/demo.txt", content: "retry" },
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()).toBeUndefined();
  });

  it("keeps unresolved mutating failure when same tool succeeds on a different target", () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-3");

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w1",
      args: { path: "/tmp/a.txt", content: "first" },
      isError: true,
      result: { error: "disk full" },
    });

    emitToolRun({
      emit,
      toolName: "write",
      toolCallId: "w2",
      args: { path: "/tmp/b.txt", content: "second" },
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("keeps unresolved session_status model-mutation failure on later read-only status success", () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-4");

    emitToolRun({
      emit,
      toolName: "session_status",
      toolCallId: "s1",
      args: { sessionKey: "agent:main:main", model: "openai/gpt-4o" },
      isError: true,
      result: { error: "Model not allowed." },
    });

    emitToolRun({
      emit,
      toolName: "session_status",
      toolCallId: "s2",
      args: { sessionKey: "agent:main:main" },
      isError: false,
      result: { ok: true },
    });

    expect(subscription.getLastToolError()?.toolName).toBe("session_status");
  });

  it("emits lifecycle:error event on agent_end when last assistant message was an error", async () => {
    const { emit, onAgentEvent } = createAgentEventHarness({
      runId: "run-error",
      sessionKey: "test-session",
    });

    emitAssistantLifecycleErrorAndEnd({
      emit,
      errorMessage: "429 Rate limit exceeded",
    });

    // Look for lifecycle:error event
    const lifecycleError = findLifecycleErrorAgentEvent(onAgentEvent.mock.calls);

    expect(lifecycleError).toBeDefined();
    expect(lifecycleError?.data?.error).toContain("API rate limit reached");
  });
});
