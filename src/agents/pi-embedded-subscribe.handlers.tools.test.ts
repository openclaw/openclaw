import { describe, expect, it, vi } from "vitest";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

const mockEmitAgentEvent = vi.fn();
vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: (...args: unknown[]) => mockEmitAgentEvent(...args),
}));

// Must import AFTER vi.mock to get the mocked version
const { handleToolExecutionEnd } = await import("./pi-embedded-subscribe.handlers.tools.js");

function createMinimalContext(overrides?: {
  onToolResult?: (payload: unknown) => void;
  shouldEmitToolOutput?: () => boolean;
}): EmbeddedPiSubscribeContext {
  const emitToolOutput = vi.fn();
  return {
    params: {
      runId: "test-run",
      onToolResult: overrides?.onToolResult,
      onAgentEvent: undefined,
    },
    state: {
      assistantTexts: [],
      toolMetas: [],
      toolMetaById: new Map(),
      toolSummaryById: new Set(),
      lastToolError: undefined,
      blockReplyBreak: "text_end",
      reasoningMode: "off",
      includeReasoning: false,
      shouldEmitPartialReplies: false,
      streamReasoning: false,
      deltaBuffer: "",
      blockBuffer: "",
      blockState: {
        thinking: false,
        final: false,
        inlineCode: { isInsideCodeSpan: false, pendingBackticks: 0, openLength: 0 },
      },
      partialBlockState: {
        thinking: false,
        final: false,
        inlineCode: { isInsideCodeSpan: false, pendingBackticks: 0, openLength: 0 },
      },
      emittedAssistantUpdate: false,
      assistantMessageIndex: 0,
      lastAssistantTextMessageIndex: -1,
      assistantTextBaseline: 0,
      suppressBlockChunks: false,
      compactionInFlight: false,
      pendingCompactionRetry: 0,
      compactionRetryPromise: null,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentTargets: [],
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
    },
    log: { debug: () => {}, warn: () => {} },
    blockChunking: undefined,
    blockChunker: null,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: overrides?.shouldEmitToolOutput ?? (() => true),
    emitToolSummary: vi.fn(),
    emitToolOutput,
    stripBlockTags: (text: string) => text,
    emitBlockChunk: () => {},
    flushBlockReplyBuffer: () => {},
    emitReasoningStream: () => {},
    consumeReplyDirectives: () => null,
    consumePartialReplyDirectives: () => null,
    resetAssistantMessageState: () => {},
    resetForCompactionRetry: () => {},
    finalizeAssistantTexts: () => {},
    trimMessagingToolSent: () => {},
    ensureCompactionPromise: () => {},
    noteCompactionRetry: () => {},
    resolveCompactionRetry: () => {},
    maybeResolveCompactionWait: () => {},
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleToolExecutionEnd", () => {
  it("emits tool output for successful tool results", () => {
    const onToolResult = vi.fn();
    const ctx = createMinimalContext({ onToolResult, shouldEmitToolOutput: () => true });
    handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "call-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "command output here" }],
      },
    } as never);

    expect(ctx.emitToolOutput).toHaveBeenCalledWith("exec", undefined, "command output here");
  });

  it("does NOT emit tool output for error tool results", () => {
    const onToolResult = vi.fn();
    const ctx = createMinimalContext({ onToolResult, shouldEmitToolOutput: () => true });
    handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "call-2",
      isError: true,
      result: {
        content: [
          { type: "text", text: "Error: command not found\nstderr output with sensitive info" },
        ],
      },
    } as never);

    expect(ctx.emitToolOutput).not.toHaveBeenCalled();
  });

  it("does NOT emit tool output when isToolResultError detects error status", () => {
    const onToolResult = vi.fn();
    const ctx = createMinimalContext({ onToolResult, shouldEmitToolOutput: () => true });
    handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call-3",
      isError: false,
      result: {
        details: { status: "error" },
        content: [{ type: "text", text: "/etc/passwd contents leaked here" }],
      },
    } as never);

    expect(ctx.emitToolOutput).not.toHaveBeenCalled();
  });

  it("omits result from emitAgentEvent for error tool results", () => {
    mockEmitAgentEvent.mockClear();
    const ctx = createMinimalContext();
    handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "call-agent-evt",
      isError: true,
      result: {
        content: [{ type: "text", text: "sensitive stderr output" }],
      },
    } as never);

    expect(mockEmitAgentEvent).toHaveBeenCalled();
    const eventData = mockEmitAgentEvent.mock.calls[0][0].data;
    expect(eventData.isError).toBe(true);
    expect(eventData.result).toBeUndefined();
  });

  it("includes result in emitAgentEvent for successful tool results", () => {
    mockEmitAgentEvent.mockClear();
    const ctx = createMinimalContext();
    handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "call-agent-evt-ok",
      isError: false,
      result: {
        content: [{ type: "text", text: "normal output" }],
      },
    } as never);

    expect(mockEmitAgentEvent).toHaveBeenCalled();
    const eventData = mockEmitAgentEvent.mock.calls[0][0].data;
    expect(eventData.isError).toBe(false);
    expect(eventData.result).toBeDefined();
  });

  it("records lastToolError for error results", () => {
    const ctx = createMinimalContext();
    handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "call-4",
      isError: true,
      result: {
        content: [{ type: "text", text: "command failed" }],
      },
    } as never);

    expect(ctx.state.lastToolError).toBeDefined();
    expect(ctx.state.lastToolError?.toolName).toBe("exec");
  });
});
