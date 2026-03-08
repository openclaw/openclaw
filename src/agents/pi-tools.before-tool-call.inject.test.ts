import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

type HookRunnerMock = {
  hasHooks: ReturnType<typeof vi.fn>;
  runBeforeToolCall: ReturnType<typeof vi.fn>;
};

function installMockHookRunner(overrides?: {
  hasHooksReturn?: boolean;
  runBeforeToolCallImpl?: (...args: unknown[]) => unknown;
}): HookRunnerMock {
  const hookRunner: HookRunnerMock = {
    hasHooks: vi.fn(() => overrides?.hasHooksReturn ?? true),
    runBeforeToolCall: overrides?.runBeforeToolCallImpl
      ? vi.fn(overrides.runBeforeToolCallImpl)
      : vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-explicit-any
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  return hookRunner;
}

describe("before_tool_call result injection", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
  });

  it("injects fake result and skips real tool execution when hook returns result", async () => {
    const fakeResult = { content: [{ type: "text", text: "INJECTED" }] };
    const hookRunner = installMockHookRunner();
    hookRunner.runBeforeToolCall.mockResolvedValue({ result: fakeResult });

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
      allowResultModification: true,
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    const result = await tool.execute(
      "call-inject-1",
      { path: "/etc/passwd" },
      undefined,
      extensionContext,
    );

    // Real execute should NOT have been called
    expect(execute).not.toHaveBeenCalled();
    // Should return the injected fake result
    expect(result).toEqual(fakeResult);
  });

  it("still calls real execute when hook returns no result field", async () => {
    const hookRunner = installMockHookRunner();
    hookRunner.runBeforeToolCall.mockResolvedValue({ params: { safe: true } });

    const realResult = { content: [{ type: "text", text: "REAL" }] };
    const execute = vi.fn().mockResolvedValue(realResult);
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    const result = await tool.execute(
      "call-inject-2",
      { path: "/tmp/ok" },
      undefined,
      extensionContext,
    );

    expect(execute).toHaveBeenCalled();
    expect(result).toEqual(realResult);
  });

  it("block takes precedence over injected result", async () => {
    const hookRunner = installMockHookRunner();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "denied",
      result: { content: [{ type: "text", text: "should not appear" }] },
    });

    const execute = vi.fn();
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "Bash", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    await expect(
      tool.execute("call-inject-3", { command: "rm -rf /" }, undefined, extensionContext),
    ).rejects.toThrow("denied");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves result field from merged multi-plugin hook output", async () => {
    // Simulates the merged output from two plugins: one sets params, the other sets result.
    // After the merger fix, the combined result should contain both.
    const hookRunner = installMockHookRunner();
    const mergedResult = { content: [{ type: "text", text: "FROM_PLUGIN_2" }] };
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { sanitized: true },
      result: mergedResult,
    });

    const execute = vi.fn().mockResolvedValue({ content: [] });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
      allowResultModification: true,
    });

    const extensionContext = {} as Parameters<typeof tool.execute>[3];
    const result = await tool.execute(
      "call-inject-4",
      { path: "/tmp/test" },
      undefined,
      extensionContext,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual(mergedResult);
  });
});
