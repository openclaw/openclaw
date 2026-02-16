import type { AgentTool } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runAfterToolCall: vi.fn(async () => {}),
  },
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  consumeAdjustedParamsForToolCall: vi.fn(() => undefined),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("./pi-tools.before-tool-call.js", () => ({
  consumeAdjustedParamsForToolCall: hookMocks.consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook: hookMocks.isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

function createReadTool() {
  return {
    name: "read",
    label: "Read",
    description: "reads",
    parameters: {},
    execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
  } satisfies AgentTool<unknown, unknown>;
}

function enableAfterToolCallHook() {
  hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");
}

async function executeReadTool(callId: string) {
  const defs = toToolDefinitions([createReadTool()]);
  return await defs[0].execute(callId, { path: "/tmp/file" }, undefined, undefined);
}

function expectReadAfterToolCallPayload(result: Awaited<ReturnType<typeof executeReadTool>>) {
  expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledWith(
    {
      toolName: "read",
      params: { mode: "safe" },
      result,
    },
    { toolName: "read" },
  );
}

describe("pi tool definition adapter after_tool_call", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.runAfterToolCall.mockReset();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReset();
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    hookMocks.consumeAdjustedParamsForToolCall.mockReset();
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    hookMocks.runBeforeToolCallHook.mockReset();
    hookMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it("dispatches after_tool_call once on successful adapter execution", async () => {
    enableAfterToolCallHook();
    hookMocks.runBeforeToolCallHook.mockResolvedValue({
      blocked: false,
      params: { mode: "safe" },
    });
    const result = await executeReadTool("call-ok");

    expect(result.details).toMatchObject({ ok: true });
    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    expectReadAfterToolCallPayload(result);
  });

  it("uses wrapped-tool adjusted params for after_tool_call payload", async () => {
    enableAfterToolCallHook();
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue({ mode: "safe" });
    const result = await executeReadTool("call-ok-wrapped");

    expect(result.details).toMatchObject({ ok: true });
    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
    expectReadAfterToolCallPayload(result);
  });

  it("dispatches after_tool_call once on adapter error with normalized tool name", async () => {
    enableAfterToolCallHook();
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-err", { cmd: "ls" }, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "boom",
    });
    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { cmd: "ls" },
        error: "boom",
      },
      { toolName: "exec" },
    );
  });

  it("does not break execution when after_tool_call hook throws", async () => {
    enableAfterToolCallHook();
    hookMocks.runner.runAfterToolCall.mockRejectedValue(new Error("hook failed"));
    const result = await executeReadTool("call-ok2");

    expect(result.details).toMatchObject({ ok: true });
    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
  });
});
