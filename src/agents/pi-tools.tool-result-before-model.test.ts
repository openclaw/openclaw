import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

type HookRunnerMock = {
  hasHooks: ReturnType<typeof vi.fn>;
  runBeforeToolCall: ReturnType<typeof vi.fn>;
  runToolResultBeforeModel: ReturnType<typeof vi.fn>;
};

function installMockHookRunner(): HookRunnerMock {
  const hookRunner: HookRunnerMock = {
    hasHooks: vi.fn(() => false),
    runBeforeToolCall: vi.fn(),
    runToolResultBeforeModel: vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-explicit-any
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  return hookRunner;
}

describe("tool_result_before_model hook", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
  });

  it("passes result through when no hook is registered", async () => {
    const hookRunner = installMockHookRunner();
    hookRunner.hasHooks.mockImplementation((name: string) => name === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const realResult = { content: [{ type: "text", text: "original" }] };
    const execute = vi.fn().mockResolvedValue(realResult);
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
      allowResultModification: true,
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    const result = await tool.execute("call-1", { path: "/tmp/file" }, undefined, extensionContext);

    expect(result).toEqual(realResult);
    expect(hookRunner.runToolResultBeforeModel).not.toHaveBeenCalled();
  });

  it("replaces result when hook returns a new result", async () => {
    const hookRunner = installMockHookRunner();
    hookRunner.hasHooks.mockImplementation(
      (name: string) => name === "before_tool_call" || name === "tool_result_before_model",
    );
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
    hookRunner.runToolResultBeforeModel.mockResolvedValue({
      result: { content: [{ type: "text", text: "REPLACED" }] },
    });

    const realResult = { content: [{ type: "text", text: "original" }] };
    const execute = vi.fn().mockResolvedValue(realResult);
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
      allowResultModification: true,
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    const result = await tool.execute("call-2", { path: "/tmp/file" }, undefined, extensionContext);

    expect(execute).toHaveBeenCalled();
    expect(result).toEqual({ content: [{ type: "text", text: "REPLACED" }] });
    expect(hookRunner.runToolResultBeforeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read",
        result: realResult,
      }),
      expect.objectContaining({
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
      }),
    );
  });

  it("also runs on injected results from before_tool_call", async () => {
    const hookRunner = installMockHookRunner();
    hookRunner.hasHooks.mockImplementation(
      (name: string) => name === "before_tool_call" || name === "tool_result_before_model",
    );

    const injected = { content: [{ type: "text", text: "INJECTED" }] };
    hookRunner.runBeforeToolCall.mockResolvedValue({ result: injected });
    hookRunner.runToolResultBeforeModel.mockResolvedValue({
      result: { content: [{ type: "text", text: "SANITIZED" }] },
    });

    const execute = vi.fn();
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
      allowResultModification: true,
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    const result = await tool.execute(
      "call-3",
      { path: "/etc/shadow" },
      undefined,
      extensionContext,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({ content: [{ type: "text", text: "SANITIZED" }] });
  });
});
