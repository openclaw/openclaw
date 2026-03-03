/**
 * Integration test: after_tool_call fires exactly once when both the adapter
 * (toToolDefinitions) and the subscription handler (handleToolExecutionEnd)
 * are active — the production scenario for embedded runs.
 *
 * Regression guard for the double-fire bug fixed by removing the adapter-side
 * after_tool_call invocation (see PR #27283 → dedup in this fix).
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => true),
    runAfterToolCall: vi.fn(async () => {}),
    runBeforeToolCall: vi.fn(async () => {}),
  },
}));

const beforeToolCallMocks = vi.hoisted(() => ({
  consumeAdjustedParamsForToolCall: vi.fn((_: string): unknown => undefined),
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

vi.mock("./pi-tools.before-tool-call.js", () => ({
  consumeAdjustedParamsForToolCall: beforeToolCallMocks.consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook: beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook: beforeToolCallMocks.runBeforeToolCallHook,
}));

function createTestTool(name: string) {
  return {
    name,
    label: name,
    description: `test tool: ${name}`,
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: { ok: true },
    })),
  } satisfies AgentTool;
}

function createFailingTool(name: string) {
  return {
    name,
    label: name,
    description: `failing tool: ${name}`,
    parameters: Type.Object({}),
    execute: vi.fn(async () => {
      throw new Error("tool failed");
    }),
  } satisfies AgentTool;
}

function createToolHandlerCtx() {
  return {
    params: {
      runId: "integration-test",
      session: { messages: [] },
    },
    hookRunner: hookMocks.runner,
    state: {
      toolMetaById: new Map<string, unknown>(),
      toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
      toolSummaryById: new Set<string>(),
      lastToolError: undefined,
      pendingMessagingTexts: new Map<string, string>(),
      pendingMessagingTargets: new Map<string, unknown>(),
      pendingMessagingMediaUrls: new Map<string, string[]>(),
      messagingToolSentTexts: [] as string[],
      messagingToolSentTextsNormalized: [] as string[],
      messagingToolSentMediaUrls: [] as string[],
      messagingToolSentTargets: [] as unknown[],
      blockBuffer: "",
      successfulCronAdds: 0,
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
}

let toToolDefinitions: typeof import("./pi-tool-definition-adapter.js").toToolDefinitions;
let handleToolExecutionStart: typeof import("./pi-embedded-subscribe.handlers.tools.js").handleToolExecutionStart;
let handleToolExecutionEnd: typeof import("./pi-embedded-subscribe.handlers.tools.js").handleToolExecutionEnd;

describe("after_tool_call fires exactly once in embedded runs", () => {
  beforeAll(async () => {
    ({ toToolDefinitions } = await import("./pi-tool-definition-adapter.js"));
    ({ handleToolExecutionStart, handleToolExecutionEnd } =
      await import("./pi-embedded-subscribe.handlers.tools.js"));
  });

  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runAfterToolCall.mockClear();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.runner.runBeforeToolCall.mockClear();
    hookMocks.runner.runBeforeToolCall.mockResolvedValue(undefined);
    beforeToolCallMocks.consumeAdjustedParamsForToolCall.mockClear();
    beforeToolCallMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook.mockClear();
    beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    beforeToolCallMocks.runBeforeToolCallHook.mockClear();
    beforeToolCallMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it("fires after_tool_call exactly once on success when both adapter and handler are active", async () => {
    const tool = createTestTool("read");
    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }

    const toolCallId = "integration-call-1";
    const args = { path: "/tmp/test.txt" };
    const ctx = createToolHandlerCtx();

    // Step 1: Simulate tool_execution_start event (SDK emits this)
    await handleToolExecutionStart(
      ctx as never,
      { type: "tool_execution_start", toolName: "read", toolCallId, args } as never,
    );

    // Step 2: Execute tool through the adapter wrapper (SDK calls this)
    const extensionContext = {} as Parameters<typeof def.execute>[4];
    await def.execute(toolCallId, args, undefined, undefined, extensionContext);

    // Step 3: Simulate tool_execution_end event (SDK emits this after execute returns)
    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId,
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      } as never,
    );

    // The hook must fire exactly once — not zero, not two.
    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
  });

  it("fires after_tool_call exactly once on error when both adapter and handler are active", async () => {
    const tool = createFailingTool("exec");
    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }

    const toolCallId = "integration-call-err";
    const args = { command: "fail" };
    const ctx = createToolHandlerCtx();

    await handleToolExecutionStart(
      ctx as never,
      { type: "tool_execution_start", toolName: "exec", toolCallId, args } as never,
    );

    const extensionContext = {} as Parameters<typeof def.execute>[4];
    await def.execute(toolCallId, args, undefined, undefined, extensionContext);

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId,
        isError: true,
        result: { status: "error", error: "tool failed" },
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);

    const call = (hookMocks.runner.runAfterToolCall as ReturnType<typeof vi.fn>).mock.calls[0];
    const event = call?.[0] as { error?: unknown } | undefined;
    expect(event?.error).toBeDefined();
  });

  it("uses before_tool_call adjusted params for after_tool_call payload", async () => {
    const tool = createTestTool("read");
    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }

    const toolCallId = "integration-call-adjusted";
    const args = { path: "/tmp/original.txt" };
    const adjusted = { path: "/tmp/adjusted.txt", mode: "safe" };
    const ctx = createToolHandlerCtx();
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    beforeToolCallMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    beforeToolCallMocks.consumeAdjustedParamsForToolCall.mockImplementation((id: string) =>
      id === toolCallId ? adjusted : undefined,
    );

    await handleToolExecutionStart(
      ctx as never,
      { type: "tool_execution_start", toolName: "read", toolCallId, args } as never,
    );
    await def.execute(toolCallId, args, undefined, undefined, extensionContext);
    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId,
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      } as never,
    );

    expect(beforeToolCallMocks.consumeAdjustedParamsForToolCall).toHaveBeenCalledWith(toolCallId);
    const event = (hookMocks.runner.runAfterToolCall as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { params?: unknown } | undefined;
    expect(event?.params).toEqual(adjusted);
  });

  it("fires after_tool_call exactly once per tool across multiple sequential tool calls", async () => {
    const tool = createTestTool("write");
    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }

    const ctx = createToolHandlerCtx();
    const extensionContext = {} as Parameters<typeof def.execute>[4];

    for (let i = 0; i < 3; i++) {
      const toolCallId = `sequential-call-${i}`;
      const args = { path: `/tmp/file-${i}.txt`, content: "data" };

      await handleToolExecutionStart(
        ctx as never,
        { type: "tool_execution_start", toolName: "write", toolCallId, args } as never,
      );

      await def.execute(toolCallId, args, undefined, undefined, extensionContext);

      await handleToolExecutionEnd(
        ctx as never,
        {
          type: "tool_execution_end",
          toolName: "write",
          toolCallId,
          isError: false,
          result: { content: [{ type: "text", text: "written" }] },
        } as never,
      );
    }

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(3);
  });
});
