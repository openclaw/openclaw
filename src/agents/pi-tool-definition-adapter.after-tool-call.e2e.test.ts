import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn((_: string) => false),
    runAfterToolCall: vi.fn(async () => {}),
  },
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  consumeAdjustedParamsForToolCall: vi.fn((_: string) => undefined as unknown),
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
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
  } satisfies AgentTool;
}

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

function enableAfterToolCallHook() {
  hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");
}

async function executeReadTool(callId: string) {
  const defs = toToolDefinitions([createReadTool()]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  const execute = (...args: Parameters<(typeof defs)[0]["execute"]>) => def.execute(...args);
  return await execute(callId, { path: "/tmp/file" }, undefined, undefined, extensionContext);
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
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.runAfterToolCall.mockClear();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockClear();
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    hookMocks.consumeAdjustedParamsForToolCall.mockClear();
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    hookMocks.runBeforeToolCallHook.mockClear();
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
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue({ mode: "safe" } as unknown);
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
      parameters: Type.Object({}),
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    const execute = (...args: Parameters<(typeof defs)[0]["execute"]>) => def.execute(...args);
    const result = await execute("call-err", { cmd: "ls" }, undefined, undefined, extensionContext);

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

  it("returns modified result when after_tool_call hook provides one (success path)", async () => {
    enableAfterToolCallHook();
    const modifiedResult = { content: [], details: { redacted: true } };
    // oxlint-disable-next-line typescript/no-explicit-any
    hookMocks.runner.runAfterToolCall.mockResolvedValue({ result: modifiedResult } as any);
    const result = await executeReadTool("call-modify");

    expect(result).toBe(modifiedResult);
    expect(result.details).toMatchObject({ redacted: true });
  });

  it("returns modified result when after_tool_call hook provides one (error path)", async () => {
    enableAfterToolCallHook();
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: Type.Object({}),
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    } satisfies AgentTool;

    const modifiedErrorResult = { content: [], details: { sanitized: true } };
    // oxlint-disable-next-line typescript/no-explicit-any
    hookMocks.runner.runAfterToolCall.mockResolvedValue({ result: modifiedErrorResult } as any);

    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    const execute = (...args: Parameters<(typeof defs)[0]["execute"]>) => def.execute(...args);
    const result = await execute(
      "call-err-modify",
      { cmd: "ls" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result).toBe(modifiedErrorResult);
    expect(result.details).toMatchObject({ sanitized: true });
  });

  it("returns original result when after_tool_call hook returns undefined", async () => {
    enableAfterToolCallHook();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    const result = await executeReadTool("call-no-modify");

    expect(result.details).toMatchObject({ ok: true });
  });
});
