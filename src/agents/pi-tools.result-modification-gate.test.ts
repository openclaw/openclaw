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
    hasHooks: vi.fn(() => true),
    runBeforeToolCall: vi.fn(),
    runToolResultBeforeModel: vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-explicit-any
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  return hookRunner;
}

describe("plugins.allowResultModification gate", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
  });

  describe("before_tool_call result injection", () => {
    it("ignores injected result when allowResultModification is off (default)", async () => {
      const hookRunner = installMockHookRunner();
      const fakeResult = { content: [{ type: "text", text: "INJECTED" }] };
      hookRunner.runBeforeToolCall.mockResolvedValue({ result: fakeResult });

      const realResult = { content: [{ type: "text", text: "REAL" }] };
      const execute = vi.fn().mockResolvedValue(realResult);
      // oxlint-disable-next-line typescript/no-explicit-any
      const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
        agentId: "main",
        sessionKey: "main",
        // allowResultModification not set → default false
      });

      const extensionContext = {} as Parameters<typeof tool.execute>[3];
      const result = await tool.execute(
        "call-gate-1",
        { path: "/etc/passwd" },
        undefined,
        extensionContext,
      );

      // Real execute SHOULD have been called because injection was blocked
      expect(execute).toHaveBeenCalled();
      expect(result).toEqual(realResult);
    });

    it("allows injected result when allowResultModification is true", async () => {
      const hookRunner = installMockHookRunner();
      const fakeResult = { content: [{ type: "text", text: "INJECTED" }] };
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
        "call-gate-2",
        { path: "/etc/passwd" },
        undefined,
        extensionContext,
      );

      // Real execute should NOT have been called
      expect(execute).not.toHaveBeenCalled();
      expect(result).toEqual(fakeResult);
    });
  });

  describe("tool_result_before_model result replacement", () => {
    it("skips result replacement when allowResultModification is off", async () => {
      const hookRunner = installMockHookRunner();
      hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
      hookRunner.runToolResultBeforeModel.mockResolvedValue({
        result: { content: [{ type: "text", text: "REPLACED" }] },
      });

      const realResult = { content: [{ type: "text", text: "REAL" }] };
      const execute = vi.fn().mockResolvedValue(realResult);
      // oxlint-disable-next-line typescript/no-explicit-any
      const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
        agentId: "main",
        sessionKey: "main",
        // allowResultModification not set → default false
      });

      const extensionContext = {} as Parameters<typeof tool.execute>[3];
      const result = await tool.execute(
        "call-gate-3",
        { path: "/tmp/file" },
        undefined,
        extensionContext,
      );

      expect(execute).toHaveBeenCalled();
      // Hook ran but its result replacement was blocked
      expect(hookRunner.runToolResultBeforeModel).toHaveBeenCalled();
      expect(result).toEqual(realResult);
    });

    it("allows result replacement when allowResultModification is true", async () => {
      const hookRunner = installMockHookRunner();
      hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
      hookRunner.runToolResultBeforeModel.mockResolvedValue({
        result: { content: [{ type: "text", text: "REPLACED" }] },
      });

      const realResult = { content: [{ type: "text", text: "REAL" }] };
      const execute = vi.fn().mockResolvedValue(realResult);
      // oxlint-disable-next-line typescript/no-explicit-any
      const tool = wrapToolWithBeforeToolCallHook({ name: "Read", execute } as any, {
        agentId: "main",
        sessionKey: "main",
        allowResultModification: true,
      });

      const extensionContext = {} as Parameters<typeof tool.execute>[3];
      const result = await tool.execute(
        "call-gate-4",
        { path: "/tmp/file" },
        undefined,
        extensionContext,
      );

      expect(execute).toHaveBeenCalled();
      expect(hookRunner.runToolResultBeforeModel).toHaveBeenCalled();
      expect(result).toEqual({ content: [{ type: "text", text: "REPLACED" }] });
    });
  });
});
