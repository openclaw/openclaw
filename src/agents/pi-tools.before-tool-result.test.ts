import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";
import { runBeforeToolResultHook } from "./pi-tools.before-tool-result.js";

// Mock dependencies
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(),
}));

vi.mock("./tool-policy.js", () => ({
  normalizeToolName: (name: string) => name.toLowerCase().replace(/\s+/g, "-"),
}));

// Mock console.warn to suppress expected warnings in tests
const originalWarn = console.warn;

describe("runBeforeToolResultHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  const mockToolResult: AgentToolResult<unknown> = {
    content: [{ type: "text", text: "test result" }],
    isError: false,
  };

  it("returns original result when no hook runner is available", async () => {
    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue(undefined);

    const result = await runBeforeToolResultHook({
      toolName: "test-tool",
      params: { arg: "value" },
      toolCallId: "call-123",
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(result.blocked).toBe(false);
    expect(result.result).toBe(mockToolResult);
  });

  it("returns original result when no hooks are registered", async () => {
    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => false,
      runBeforeToolResult: vi.fn(),
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    const result = await runBeforeToolResultHook({
      toolName: "test-tool",
      params: { arg: "value" },
      toolCallId: "call-123",
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(result.blocked).toBe(false);
    expect(result.result).toBe(mockToolResult);
  });

  it("returns modified result when hook modifies content", async () => {
    const modifiedResult: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "sanitized result" }],
      isError: false,
    };

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult: vi.fn().mockResolvedValue({
        content: modifiedResult,
      }),
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    const result = await runBeforeToolResultHook({
      toolName: "test-tool",
      params: { arg: "value" },
      toolCallId: "call-123",
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(result.blocked).toBe(false);
    expect(result.result).toEqual(modifiedResult);
  });

  it("returns blocked status when hook blocks result", async () => {
    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult: vi.fn().mockResolvedValue({
        block: true,
        blockReason: "Sensitive content detected",
      }),
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    const result = await runBeforeToolResultHook({
      toolName: "test-tool",
      params: { arg: "value" },
      toolCallId: "call-123",
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("Sensitive content detected");
  });

  it("uses default block reason when not provided", async () => {
    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult: vi.fn().mockResolvedValue({
        block: true,
        // No blockReason
      }),
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    const result = await runBeforeToolResultHook({
      toolName: "test-tool",
      params: { arg: "value" },
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("Tool result blocked by plugin hook");
  });

  it("handles hook errors gracefully and returns original result", async () => {
    const warnSpy = vi.fn();
    console.warn = warnSpy;

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult: vi.fn().mockRejectedValue(new Error("Hook failed")),
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    const result = await runBeforeToolResultHook({
      toolName: "test-tool",
      params: { arg: "value" },
      toolCallId: "call-123",
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(result.blocked).toBe(false);
    expect(result.result).toBe(mockToolResult);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("before_tool_result hook failed: tool=test-tool"),
    );
  });

  it("normalizes params to object when not an object", async () => {
    const runBeforeToolResult = vi.fn().mockResolvedValue(undefined);

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await runBeforeToolResultHook({
      toolName: "test-tool",
      params: "not an object", // string instead of object
      toolCallId: "call-123",
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(runBeforeToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {}, // should be normalized to empty object
      }),
      expect.any(Object),
    );
  });

  it("preserves valid params object", async () => {
    const runBeforeToolResult = vi.fn().mockResolvedValue(undefined);

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    const params = { key: "value", num: 42 };

    await runBeforeToolResultHook({
      toolName: "test-tool",
      params,
      toolCallId: "call-123",
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(runBeforeToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ params }),
      expect.any(Object),
    );
  });

  it("uses empty string for missing toolCallId", async () => {
    const runBeforeToolResult = vi.fn().mockResolvedValue(undefined);

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await runBeforeToolResultHook({
      toolName: "test-tool",
      params: {},
      // No toolCallId
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(runBeforeToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "" }),
      expect.any(Object),
    );
  });

  it("passes context to hook correctly", async () => {
    const runBeforeToolResult = vi.fn().mockResolvedValue(undefined);

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await runBeforeToolResultHook({
      toolName: "test-tool",
      params: { arg: "value" },
      toolCallId: "call-123",
      result: mockToolResult,
      isError: true,
      durationMs: 500,
      ctx: {
        agentId: "agent-42",
        sessionKey: "session-abc",
      },
    });

    // Verify event passed correctly
    expect(runBeforeToolResult.mock.calls[0][0]).toMatchObject({
      toolName: "test-tool",
      toolCallId: "call-123",
      isError: true,
      durationMs: 500,
    });

    // Verify context passed correctly
    expect(runBeforeToolResult.mock.calls[0][1]).toMatchObject({
      toolName: "test-tool",
      agentId: "agent-42",
      sessionKey: "session-abc",
    });
  });

  it("uses tool name from args, not normalized", async () => {
    const runBeforeToolResult = vi.fn().mockResolvedValue(undefined);

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await runBeforeToolResultHook({
      toolName: "my_custom_tool",
      params: {},
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    // Event should use normalized name from tool-policy mock
    expect(runBeforeToolResult.mock.calls[0][0].toolName).toBe("my_custom_tool");
  });

  it("handles null params gracefully", async () => {
    const runBeforeToolResult = vi.fn().mockResolvedValue(undefined);

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await runBeforeToolResultHook({
      toolName: "test-tool",
      params: null,
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(runBeforeToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ params: {} }),
      expect.any(Object),
    );
  });

  it("handles undefined context gracefully", async () => {
    const runBeforeToolResult = vi.fn().mockResolvedValue(undefined);

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult,
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await runBeforeToolResultHook({
      toolName: "test-tool",
      params: {},
      result: mockToolResult,
      isError: false,
      durationMs: 100,
      // No ctx provided
    });

    expect(runBeforeToolResult.mock.calls[0][1]).toMatchObject({
      toolName: "test-tool",
      agentId: undefined,
      sessionKey: undefined,
    });
  });

  it("logs toolCallId in error message when provided", async () => {
    const warnSpy = vi.fn();
    console.warn = warnSpy;

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult: vi.fn().mockRejectedValue(new Error("Hook failed")),
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await runBeforeToolResultHook({
      toolName: "test-tool",
      params: {},
      toolCallId: "call-xyz-789",
      result: mockToolResult,
      isError: false,
      durationMs: 100,
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("toolCallId=call-xyz-789"));
  });

  it("does not include toolCallId in error message when not provided", async () => {
    const warnSpy = vi.fn();
    console.warn = warnSpy;

    vi.mocked(hookRunnerGlobal.getGlobalHookRunner).mockReturnValue({
      hasHooks: () => true,
      runBeforeToolResult: vi.fn().mockRejectedValue(new Error("Hook failed")),
    } as unknown as ReturnType<typeof hookRunnerGlobal.getGlobalHookRunner>);

    await runBeforeToolResultHook({
      toolName: "test-tool",
      params: {},
      result: mockToolResult,
      isError: false,
      durationMs: 100,
      // No toolCallId
    });

    // Should not have toolCallId in the message
    expect(warnSpy).toHaveBeenCalledWith(expect.not.stringContaining("toolCallId="));
  });
});
