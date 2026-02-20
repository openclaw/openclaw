import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

/**
 * Regression tests for https://github.com/openclaw/openclaw/issues/19381
 *
 * Plugin-registered tools that go through toToolDefinitions as unwrapped tools
 * (without wrapToolWithBeforeToolCallHook) must still receive the correct
 * sessionKey and agentId in their before_tool_call and after_tool_call hooks.
 */

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn((_: string) => false),
    runBeforeToolCall: vi.fn(async (_event: unknown, _ctx: unknown) => undefined as unknown),
    runAfterToolCall: vi.fn(async () => {}),
  },
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  consumeAdjustedParamsForToolCall: vi.fn((_: string) => undefined as unknown),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false as const,
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

function createPluginTool() {
  return {
    name: "my_plugin_tool",
    label: "My Plugin Tool",
    description: "plugin tool for testing",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
  } satisfies AgentTool;
}

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

describe("toToolDefinitions passes hookContext (#19381)", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.runBeforeToolCall.mockReset();
    hookMocks.runner.runAfterToolCall.mockReset();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReset();
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    hookMocks.consumeAdjustedParamsForToolCall.mockReset();
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    hookMocks.runBeforeToolCallHook.mockReset();
    hookMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false as const,
      params,
    }));
  });

  it("passes agentId and sessionKey to before_tool_call for unwrapped tools", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const defs = toToolDefinitions([createPluginTool()], {
      agentId: "main",
      sessionKey: "agent:main:tlon:dm:~user",
    });

    await defs[0].execute("call-ctx-1", { action: "test" }, undefined, undefined, extensionContext);

    expect(hookMocks.runBeforeToolCallHook).toHaveBeenCalledWith({
      toolName: "my_plugin_tool",
      params: { action: "test" },
      toolCallId: "call-ctx-1",
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:tlon:dm:~user",
      },
    });
  });

  it("passes agentId and sessionKey to after_tool_call on success", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");

    const defs = toToolDefinitions([createPluginTool()], {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:slack:channel:C123",
    });

    const result = await defs[0].execute("call-ctx-2", {}, undefined, undefined, extensionContext);

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledWith(
      {
        toolName: "my_plugin_tool",
        params: {},
        result,
      },
      {
        toolName: "my_plugin_tool",
        agentId: "agent-1",
        sessionKey: "agent:agent-1:slack:channel:C123",
      },
    );
  });

  it("passes agentId and sessionKey to after_tool_call on error", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");

    const errorTool = {
      name: "failing_tool",
      label: "Failing",
      description: "throws",
      parameters: Type.Object({}),
      execute: vi.fn(async () => {
        throw new Error("tool failure");
      }),
    } satisfies AgentTool;

    const defs = toToolDefinitions([errorTool], {
      agentId: "main",
      sessionKey: "main-session",
    });

    await defs[0].execute("call-ctx-3", { cmd: "test" }, undefined, undefined, extensionContext);

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledWith(
      {
        toolName: "failing_tool",
        params: { cmd: "test" },
        error: "tool failure",
      },
      {
        toolName: "failing_tool",
        agentId: "main",
        sessionKey: "main-session",
      },
    );
  });

  it("works without hookContext (backwards compatible)", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    // No hookContext passed — should still work, just with undefined ctx
    const defs = toToolDefinitions([createPluginTool()]);

    await defs[0].execute("call-no-ctx", {}, undefined, undefined, extensionContext);

    expect(hookMocks.runBeforeToolCallHook).toHaveBeenCalledWith({
      toolName: "my_plugin_tool",
      params: {},
      toolCallId: "call-no-ctx",
      ctx: undefined,
    });
  });
});
