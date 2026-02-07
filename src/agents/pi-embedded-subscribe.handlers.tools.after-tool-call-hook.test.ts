import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { handleToolExecutionEnd } from "./pi-embedded-subscribe.handlers.tools.js";

vi.mock("../plugins/hook-runner-global.js");
vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

function makeCtx(overrides?: Partial<{ runId: string }>) {
  const runId = overrides?.runId ?? "agent-123:run-1";
  return {
    params: {
      runId,
      onAgentEvent: vi.fn(),
      onToolResult: undefined,
    },
    state: {
      toolMetaById: new Map<string, string | undefined>(),
      toolArgsById: new Map<string, Record<string, unknown>>(),
      toolSummaryById: new Set<string>(),
      toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
      pendingMessagingTexts: new Map<string, string>(),
      pendingMessagingTargets: new Map<string, unknown>(),
      messagingToolSentTexts: [] as string[],
      messagingToolSentTextsNormalized: [] as string[],
      messagingToolSentTargets: [] as unknown[],
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    shouldEmitToolOutput: vi.fn().mockReturnValue(false),
    shouldEmitToolResult: vi.fn().mockReturnValue(false),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

function makeEvt(
  overrides?: Partial<{ toolName: string; toolCallId: string; isError: boolean; result: unknown }>,
) {
  return {
    type: "tool_execution_end",
    toolName: overrides?.toolName ?? "Read",
    toolCallId: overrides?.toolCallId ?? "call-1",
    isError: overrides?.isError ?? false,
    result: overrides?.result ?? { content: [{ type: "text", text: "file contents" }] },
  };
}

describe("after_tool_call hook integration", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runAfterToolCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    hookRunner = {
      hasHooks: vi.fn(),
      runAfterToolCall: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  });

  it("does not invoke hook when no hooks are registered", () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const ctx = makeCtx();
    handleToolExecutionEnd(ctx, makeEvt());

    expect(hookRunner.hasHooks).toHaveBeenCalledWith("after_tool_call");
    expect(hookRunner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("fires hook with tool name and result on successful execution", () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const ctx = makeCtx({ runId: "myagent:run-42" });
    const result = { content: [{ type: "text", text: "ok" }] };
    // "Bash" normalizes to "exec" via TOOL_NAME_ALIASES.
    handleToolExecutionEnd(ctx, makeEvt({ toolName: "Bash", result }));

    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        params: {},
        error: undefined,
      }),
      expect.objectContaining({
        toolName: "exec",
        agentId: "myagent",
      }),
    );
  });

  it("includes error string when tool result is an error", () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const ctx = makeCtx();
    const errorResult = {
      content: [{ type: "text", text: "Error: file not found" }],
      isError: true,
    };
    handleToolExecutionEnd(ctx, makeEvt({ isError: true, result: errorResult }));

    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(String),
      }),
      expect.anything(),
    );
  });

  it("continues execution when hook rejects", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockRejectedValue(new Error("hook failure"));
    const ctx = makeCtx();

    // Should not throw - fire-and-forget pattern catches errors.
    handleToolExecutionEnd(ctx, makeEvt());

    // Give the microtask queue a tick so the .catch() handler runs.
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("after_tool_call hook failed"),
    );
  });

  it("does not invoke hook when hookRunner is null", () => {
    mockGetGlobalHookRunner.mockReturnValue(null);
    const ctx = makeCtx();

    // Should not throw.
    handleToolExecutionEnd(ctx, makeEvt());
  });

  it("passes stored tool args from start to end via toolArgsById", () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const ctx = makeCtx();
    // Simulate handleToolExecutionStart having stored args for this toolCallId.
    ctx.state.toolArgsById.set("call-1", { path: "/tmp/file", encoding: "utf-8" });

    handleToolExecutionEnd(ctx, makeEvt({ toolCallId: "call-1", toolName: "Read" }));

    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { path: "/tmp/file", encoding: "utf-8" },
      }),
      expect.anything(),
    );
    // Args should be cleaned up after use.
    expect(ctx.state.toolArgsById.has("call-1")).toBe(false);
  });
});
