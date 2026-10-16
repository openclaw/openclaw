// Regression: both adapter and subscription are active in embedded runs (PR #27283).
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseToolHandlerState } from "./agent-tool-handler-state.test-helpers.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { prepareToolResult } from "./embedded-agent-tool-results.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => true),
    runAfterToolCall: vi.fn(async () => {}),
    runBeforeToolCall: vi.fn(async () => {}),
  },
}));

const beforeToolCallMocks = vi.hoisted(() => ({
  consumeAdjustedParamsForToolCall: vi.fn((_toolCallId: string): unknown => undefined),
  recordAdjustedParamsForToolCall: vi.fn(),
  recordStructuredReplayTrustForToolCall: vi.fn(),
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

function createTestTool(name: string, fail = false) {
  return {
    name,
    label: name,
    description: `test tool: ${name}`,
    parameters: Type.Object({}),
    execute: vi.fn(async () => {
      if (fail) {
        throw new Error("tool failed");
      }
      return { content: [{ type: "text" as const, text: "ok" }], details: { ok: true } };
    }),
  } satisfies AgentTool;
}

function createToolHandlerCtx() {
  return {
    params: { runId: "integration-test", session: { messages: [] } },
    hookRunner: hookMocks.runner,
    state: { ...createBaseToolHandlerState(), successfulCronAdds: 0 },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
}

let toToolDefinitions: typeof import("./agent-tool-definition-adapter.js").toToolDefinitions;
let handleToolExecutionStart: typeof import("./embedded-agent-subscribe.handlers.tools.start.js").handleToolExecutionStart;
let handleToolExecutionEnd: typeof import("./embedded-agent-subscribe.handlers.tools.completion.js").handleToolExecutionEnd;

async function loadFreshAfterToolCallModulesForTest() {
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => hookMocks.runner,
  }));
  vi.doMock("../infra/agent-events.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../infra/agent-events.js")>()),
    emitAgentCommandOutputEvent: vi.fn(),
    emitAgentEvent: vi.fn(),
    emitAgentItemEvent: vi.fn(),
  }));
  vi.doMock("./agent-tools.before-tool-call.state.js", () => ({
    consumeAdjustedParamsForToolCall: beforeToolCallMocks.consumeAdjustedParamsForToolCall,
    consumePreExecutionBlockedToolCall: vi.fn(() => false),
    consumeTrackedToolExecutionStarted: vi.fn(() => undefined),
    consumeStructuredReplaySafeToolCall: vi.fn(() => false),
    peekAdjustedParamsForToolCall: vi.fn(() => undefined),
    peekPreExecutionBlockedToolCall: vi.fn(() => false),
  }));
  vi.doMock("./agent-tools.before-tool-call.js", () => ({
    buildBlockedToolResult: ({ reason }: { reason: string }) => ({
      content: [{ type: "text", text: reason }],
      details: { status: "blocked", deniedReason: "plugin-before-tool-call", reason },
    }),
    consumeAdjustedParamsForToolCall: beforeToolCallMocks.consumeAdjustedParamsForToolCall,
    consumePreExecutionBlockedToolCall: vi.fn(() => false),
    recordAdjustedParamsForToolCall: beforeToolCallMocks.recordAdjustedParamsForToolCall,
    recordStructuredReplayTrustForToolCall:
      beforeToolCallMocks.recordStructuredReplayTrustForToolCall,
    isToolWrappedWithBeforeToolCallHook: beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook,
    runBeforeToolCallHook: beforeToolCallMocks.runBeforeToolCallHook,
  }));
  ({ toToolDefinitions } = await import("./agent-tool-definition-adapter.js"));
  ({ handleToolExecutionStart } =
    await import("./embedded-agent-subscribe.handlers.tools.start.js"));
  ({ handleToolExecutionEnd } =
    await import("./embedded-agent-subscribe.handlers.tools.completion.js"));
}

describe("after_tool_call fires exactly once in embedded runs", () => {
  beforeAll(loadFreshAfterToolCallModulesForTest);

  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.runner.runBeforeToolCall.mockResolvedValue(undefined);
    beforeToolCallMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    beforeToolCallMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  function createToolCall(toolName: string, fail = false) {
    const tool = createTestTool(toolName, fail);
    const def = toToolDefinitions([tool])[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    const extensionContext = {} as Parameters<typeof def.execute>[4];
    return (toolCallId: string, args: Record<string, unknown>, ctx = createToolHandlerCtx()) => ({
      async start() {
        await handleToolExecutionStart(
          ctx as never,
          { type: "tool_execution_start", toolName, toolCallId, args } as never,
        );
        await def.execute(toolCallId, args, undefined, undefined, extensionContext);
      },
      async end(result: unknown) {
        await handleToolExecutionEnd(
          ctx as never,
          { type: "tool_execution_end", toolName, toolCallId, isError: fail, result } as never,
          prepareToolResult(result),
        );
      },
    });
  }

  it("fires after_tool_call exactly once on error when both adapter and handler are active", async () => {
    const call = createToolCall("exec", true)("integration-call-err", { command: "fail" });
    await call.start();
    await call.end({ status: "error", error: "tool failed" });

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    const event = (hookMocks.runner.runAfterToolCall as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { error?: unknown } | undefined;
    expect(event?.error).toBe("tool failed");
  });

  it("uses before_tool_call adjusted params for after_tool_call payload", async () => {
    const toolCallId = "integration-call-adjusted";
    const args = { path: "/tmp/original.txt" };
    const adjusted = { path: "/tmp/adjusted.txt", mode: "safe" };
    const call = createToolCall("read")(toolCallId, args);

    beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    beforeToolCallMocks.consumeAdjustedParamsForToolCall.mockImplementation((id: string) =>
      id === toolCallId ? adjusted : undefined,
    );

    await call.start();
    expect(beforeToolCallMocks.consumeAdjustedParamsForToolCall).not.toHaveBeenCalled();
    await call.end({ content: [{ type: "text", text: "ok" }] });

    expect(beforeToolCallMocks.consumeAdjustedParamsForToolCall).toHaveBeenCalledExactlyOnceWith(
      toolCallId,
      "integration-test",
    );
    const event = (hookMocks.runner.runAfterToolCall as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { params?: unknown } | undefined;
    expect(event?.params).toEqual(adjusted);
  });

  it("fires after_tool_call exactly once per tool across multiple sequential tool calls", async () => {
    const ctx = createToolHandlerCtx();
    const toolCall = createToolCall("write");

    for (let i = 0; i < 3; i++) {
      const call = toolCall(
        `sequential-call-${i}`,
        { path: `/tmp/file-${i}.txt`, content: "data" },
        ctx,
      );
      await call.start();
      await call.end({ content: [{ type: "text", text: "written" }] });
    }

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(3);
  });
});
