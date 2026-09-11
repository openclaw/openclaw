import { afterEach, describe, expect, it, vi } from "vitest";
import { TURN_FINALIZE_DRAIN_ABORT_GRACE_MS } from "./attempt-timeouts.js";
import { handleDynamicToolCallWithTimeout } from "./dynamic-tool-execution.js";

describe("dynamic tool owner timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retains the concrete tool owner when timeout wins before a snapshot", async () => {
    vi.useFakeTimers();
    const ownerKey = '["memory-lancedb","memory_store"]';
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: true,
      sideEffectEvidence: true,
      effectReceipt: { state: "uncertain" as const },
    }));
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-owner-timeout",
        namespace: null,
        tool: "memory_store",
        arguments: { text: "Tuesday 09:00 release window" },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => {})),
        consumeToolExecutionSnapshot: vi.fn(() => undefined),
        sideEffectOwnerKeyForTool: vi.fn(() => ownerKey),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      observeToolTerminal,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({ success: false });
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerMutation: { ownerKey },
        outcome: "failure",
      }),
    );
  });

  it("settles a committed final source delivery before notifying terminal observers", async () => {
    vi.useFakeTimers();
    const onAgentToolResult = vi.fn();
    const onFinalSourceReplyDelivery = vi.fn();
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: true,
      executedArguments: { action: "send", message: "done", final: true },
      sideEffectEvidence: true,
      effectReceipt: { state: "mutation_committed" as const },
    }));
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-final-source-middleware-timeout",
        namespace: null,
        tool: "message",
        arguments: { action: "send", message: "done", final: true },
      },
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          options?.onFinalSourceReplyDelivery?.();
          return new Promise<never>(() => {});
        }),
        consumeToolExecutionSnapshot: vi.fn(() => ({
          executionStarted: true,
          executedArguments: { action: "send", message: "done", final: true },
        })),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      onAgentToolResult,
      onFinalSourceReplyDelivery,
      observeToolTerminal,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: "Source reply delivered." }],
      executionStarted: true,
      finalCurrentSourceReply: true,
      sideEffectEvidence: true,
    });
    expect(onFinalSourceReplyDelivery).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
      toolName: "message",
      result: {
        content: [{ type: "text", text: "Source reply delivered." }],
        details: { status: "success", sourceReplyDelivered: true },
      },
      isError: false,
    });
    expect(observeToolTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolCallId: "call-final-source-middleware-timeout",
        toolName: "message",
        outcome: "success",
        result: expect.objectContaining({ success: true, finalCurrentSourceReply: true }),
      }),
    );
  });

  it("normalizes a middleware-rewritten final delivery before result observers", async () => {
    const onAgentToolResult = vi.fn();
    const onFinalSourceReplyDelivery = vi.fn();
    const observeToolTerminal = vi.fn();
    const executedArguments = { action: "send", message: "done", final: true };
    const response = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-final-source-middleware-error",
        namespace: null,
        tool: "message",
        arguments: { ...executedArguments, final: false },
      },
      toolBridge: {
        handleToolCall: vi.fn(async (_call, options) => {
          options?.onFinalSourceReplyDelivery?.();
          options?.onAgentToolResult?.({
            toolName: "message",
            result: {
              content: [{ type: "text", text: "middleware rejected presentation" }],
              details: { status: "failed" },
            },
            isError: true,
          });
          return {
            success: false,
            contentItems: [{ type: "inputText", text: "middleware rejected presentation" }],
            executedArguments,
          };
        }),
        consumeToolExecutionSnapshot: vi.fn(() => ({
          executionStarted: true,
          executedArguments,
        })),
      },
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      onAgentToolResult,
      onFinalSourceReplyDelivery,
      observeToolTerminal,
    });

    expect(response).toMatchObject({
      success: true,
      finalCurrentSourceReply: true,
      executedArguments,
    });
    expect(onFinalSourceReplyDelivery).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
      toolName: "message",
      result: {
        content: [{ type: "text", text: "Source reply delivered." }],
        details: { status: "success", sourceReplyDelivered: true },
      },
      isError: false,
    });
    expect(observeToolTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolCallId: "call-final-source-middleware-error",
        toolName: "message",
        outcome: "success",
        result: expect.objectContaining({ success: true, finalCurrentSourceReply: true }),
      }),
    );
  });

  it("settles a committed final source delivery when the run is cancelled", async () => {
    const controller = new AbortController();
    const onAgentToolResult = vi.fn();
    const onFinalSourceReplyDelivery = vi.fn();
    const observeToolTerminal = vi.fn();
    let reportFinalSourceReplyDelivery: (() => void) | undefined;
    const executedArguments = { action: "send", message: "done", final: true };
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-final-source-run-cancelled",
        namespace: null,
        tool: "message",
        arguments: { ...executedArguments, final: false },
      },
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          reportFinalSourceReplyDelivery = options?.onFinalSourceReplyDelivery;
          return new Promise<never>(() => {});
        }),
        consumeToolExecutionSnapshot: vi.fn(() => ({
          executionStarted: true,
          executedArguments,
        })),
      },
      signal: controller.signal,
      timeoutMs: 1_000,
      onAgentToolResult,
      onFinalSourceReplyDelivery,
      observeToolTerminal,
    });

    controller.abort("caller cancelled while delivery was settling");
    await Promise.resolve();
    expect(onAgentToolResult).not.toHaveBeenCalled();
    expect(observeToolTerminal).not.toHaveBeenCalled();
    expect(reportFinalSourceReplyDelivery).toBeDefined();
    reportFinalSourceReplyDelivery?.();

    await expect(response).resolves.toMatchObject({
      success: true,
      finalCurrentSourceReply: true,
      executedArguments,
    });
    expect(onFinalSourceReplyDelivery).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
      toolName: "message",
      result: {
        content: [{ type: "text", text: "Source reply delivered." }],
        details: { status: "success", sourceReplyDelivered: true },
      },
      isError: false,
    });
    expect(observeToolTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolCallId: "call-final-source-run-cancelled",
        toolName: "message",
        outcome: "success",
        result: expect.objectContaining({ success: true, finalCurrentSourceReply: true }),
      }),
    );
  });

  it("settles a final-source receipt that arrives after the tool timeout", async () => {
    vi.useFakeTimers();
    const onAgentToolResult = vi.fn();
    const onFinalSourceReplyDelivery = vi.fn();
    const observeToolTerminal = vi.fn();
    const onTimeout = vi.fn();
    let reportFinalSourceReplyDelivery: (() => void) | undefined;
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-final-source-after-timeout",
        namespace: null,
        tool: "message",
        arguments: { action: "send", message: "done", final: true },
      },
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          reportFinalSourceReplyDelivery = options?.onFinalSourceReplyDelivery;
          return new Promise<never>(() => {});
        }),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      onAgentToolResult,
      onFinalSourceReplyDelivery,
      observeToolTerminal,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onAgentToolResult).not.toHaveBeenCalled();
    expect(observeToolTerminal).not.toHaveBeenCalled();
    reportFinalSourceReplyDelivery?.();

    await expect(response).resolves.toMatchObject({
      success: true,
      finalCurrentSourceReply: true,
    });
    expect(onFinalSourceReplyDelivery).toHaveBeenCalledOnce();
    expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
      toolName: "message",
      result: {
        content: [{ type: "text", text: "Source reply delivered." }],
        details: { status: "success", sourceReplyDelivered: true },
      },
      isError: false,
    });
    expect(observeToolTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "success" }),
    );
  });

  it("closes late final-source authority after bounded cancellation reconciliation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onFinalSourceReplyDelivery = vi.fn();
    const observeToolTerminal = vi.fn();
    let reportFinalSourceReplyDelivery: (() => void) | undefined;
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-final-source-after-cancellation-grace",
        namespace: null,
        tool: "message",
        arguments: { action: "send", message: "done", final: true },
      },
      toolBridge: {
        handleToolCall: vi.fn((_call, options) => {
          reportFinalSourceReplyDelivery = options?.onFinalSourceReplyDelivery;
          return new Promise<never>(() => {});
        }),
      },
      signal: controller.signal,
      timeoutMs: 60_000,
      onFinalSourceReplyDelivery,
      observeToolTerminal,
    });
    const settled = vi.fn();
    void response.then(settled);

    controller.abort("caller cancelled before delivery");
    await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({
      success: false,
      diagnosticTerminalReason: "cancelled",
    });
    expect(observeToolTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failure" }),
    );
    reportFinalSourceReplyDelivery?.();
    expect(onFinalSourceReplyDelivery).not.toHaveBeenCalled();
    expect(observeToolTerminal).toHaveBeenCalledOnce();
  });

  it("preserves a successful final delivery result for private observers", async () => {
    const onAgentToolResult = vi.fn();
    const executedArguments = { action: "send", message: "done", final: true };
    const detailedResult = {
      content: [{ type: "text" as const, text: "Sent." }],
      details: { status: "success", messageId: "synthetic-message-id" },
    };
    const response = await handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-final-source-success-details",
        namespace: null,
        tool: "message",
        arguments: executedArguments,
      },
      toolBridge: {
        handleToolCall: vi.fn(async (_call, options) => {
          options?.onFinalSourceReplyDelivery?.();
          options?.onAgentToolResult?.({
            toolName: "message",
            result: detailedResult,
            isError: false,
          });
          return {
            success: true,
            contentItems: [{ type: "inputText", text: "Sent." }],
            finalCurrentSourceReply: true,
            executedArguments,
          };
        }),
      },
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      onAgentToolResult,
    });

    expect(response).toMatchObject({ success: true, finalCurrentSourceReply: true });
    expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
      toolName: "message",
      result: detailedResult,
      isError: false,
    });
  });
});
