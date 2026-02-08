import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { wrapToolWithAfterToolCallHook } from "./pi-tools.after-tool-call.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

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

  it("executes tool normally when no hook is registered", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    const result = await tool.execute("call-1", { path: "/tmp/file" }, undefined, undefined);

    expect(hookRunner.runAfterToolCall).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith("call-1", { path: "/tmp/file" }, undefined, undefined);
    expect(result).toEqual({ content: [], details: { ok: true } });
  });

  it("fires with correct event data after tool execution", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "exec", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    await tool.execute("call-2", { cmd: "ls" }, undefined, undefined);

    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { cmd: "ls" },
        result: { content: [], details: { ok: true } },
        error: undefined,
        durationMs: expect.any(Number),
      },
      {
        toolName: "exec",
        agentId: "main",
        sessionKey: "main",
      },
    );
  });

  it("is fire-and-forget (does not block tool result)", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    // Hook returns a promise that never resolves
    hookRunner.runAfterToolCall.mockReturnValue(new Promise(() => {}));
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "exec", execute } as any);

    const result = await tool.execute("call-3", { cmd: "ls" }, undefined, undefined);

    expect(result).toEqual({ content: [], details: { ok: true } });
    expect(hookRunner.runAfterToolCall).toHaveBeenCalled();
  });

  it("receives error info when tool execution fails", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const execute = vi.fn().mockRejectedValue(new Error("command failed"));
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "exec", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    await expect(tool.execute("call-4", { cmd: "bad" }, undefined, undefined)).rejects.toThrow(
      "command failed",
    );

    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { cmd: "bad" },
        result: undefined,
        error: expect.stringContaining("command failed"),
        durationMs: expect.any(Number),
      },
      {
        toolName: "exec",
        agentId: "main",
        sessionKey: "main",
      },
    );
  });

  it("continues execution when hook throws synchronously", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockImplementation(() => {
      throw new Error("hook boom");
    });
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "read", execute } as any);

    const result = await tool.execute("call-5", { path: "/tmp/file" }, undefined, undefined);

    expect(result).toEqual({ content: [], details: { ok: true } });
  });

  it("continues execution when hook rejects asynchronously", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockRejectedValue(new Error("async hook boom"));
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "read", execute } as any);

    const result = await tool.execute("call-6", { path: "/tmp/file" }, undefined, undefined);

    expect(result).toEqual({ content: [], details: { ok: true } });
  });

  it("does not fire after_tool_call when before_tool_call blocks execution", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    // Simulate what wrapToolWithBeforeToolCallHook does when it blocks:
    // it throws an Error with the block reason
    const execute = vi.fn().mockRejectedValue(new Error("Tool call blocked by plugin hook"));
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "exec", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    await expect(tool.execute("call-b", { cmd: "rm -rf /" }, undefined, undefined)).rejects.toThrow(
      "blocked by plugin hook",
    );

    // after_tool_call must NOT fire for blocked calls — the underlying
    // tool never actually executed
    expect(hookRunner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("normalizes non-object params for hook contract", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "ReAd", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    await tool.execute("call-7", "not-an-object", undefined, undefined);

    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: {},
        result: { content: [], details: { ok: true } },
        error: undefined,
        durationMs: expect.any(Number),
      },
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
      },
    );
  });
});
