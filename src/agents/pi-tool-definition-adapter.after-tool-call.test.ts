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
  hookMocks.runner.hasHooks.mockReturnValue(true);
}

async function executeReadTool(callId: string) {
  const defs = toToolDefinitions([createReadTool()]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return def.execute(callId, { path: "/tmp/file" }, undefined, undefined, extensionContext);
}

describe("pi tool definition adapter after_tool_call", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
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

  it("does not fire after_tool_call when no hooks registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const result = await executeReadTool("call-no-hooks");

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ ok: true });
  });

  it("fires after_tool_call from the adapter on success when hooks registered", async () => {
    enableAfterToolCallHook();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    const result = await executeReadTool("call-ok");

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ ok: true });
  });

  it("fires after_tool_call from the adapter on error when hooks registered", async () => {
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
    await def.execute("call-err", { cmd: "ls" }, undefined, undefined, extensionContext);

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

  it("consumes adjusted params for wrapped tools to pass to after_tool_call hook", async () => {
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    const defs = toToolDefinitions([createReadTool()]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    await def.execute(
      "call-wrapped",
      { path: "/tmp/file" },
      undefined,
      undefined,
      extensionContext,
    );

    // before_tool_call is skipped for wrapped tools (handled by subscription handler)
    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
    // but adjusted params are consumed for the after_tool_call hook event
    expect(hookMocks.consumeAdjustedParamsForToolCall).toHaveBeenCalledWith("call-wrapped");
  });
});
