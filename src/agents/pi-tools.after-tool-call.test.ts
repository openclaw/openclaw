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

  it("fires after_tool_call on successful execution", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const result = { content: [{ type: "text", text: "ok" }], details: { ok: true } };
    const execute = vi.fn().mockResolvedValue(result);
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    const out = await tool.execute("call-1", { path: "/tmp/file" }, undefined, undefined);

    expect(out).toBe(result);
    // Allow microtask for fire-and-forget promise
    await new Promise((r) => setTimeout(r, 0));
    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read",
        params: { path: "/tmp/file" },
        result,
        error: undefined,
      }),
      {
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
      },
    );
  });

  it("fires after_tool_call with error when tool throws", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const execute = vi.fn().mockRejectedValue(new Error("boom"));
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "exec", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });

    await expect(tool.execute("call-2", { cmd: "ls" }, undefined, undefined)).rejects.toThrow(
      "boom",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        params: { cmd: "ls" },
        error: "boom",
      }),
      expect.objectContaining({ toolName: "exec" }),
    );
  });

  it("does not call hook when no hooks are registered", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "Read", execute } as any);

    await tool.execute("call-3", { path: "/tmp" }, undefined, undefined);

    await new Promise((r) => setTimeout(r, 0));
    expect(hookRunner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("does not affect tool result when hook throws", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockRejectedValue(new Error("hook-fail"));
    const result = { content: [], details: { ok: true } };
    const execute = vi.fn().mockResolvedValue(result);
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "Read", execute } as any);

    const out = await tool.execute("call-4", { path: "/tmp" }, undefined, undefined);

    expect(out).toBe(result);
  });

  it("includes durationMs in hook event", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runAfterToolCall.mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithAfterToolCallHook({ name: "Read", execute } as any);

    await tool.execute("call-5", {}, undefined, undefined);

    await new Promise((r) => setTimeout(r, 0));
    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: expect.any(Number),
      }),
      expect.anything(),
    );
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

    await tool.execute("call-6", "not-an-object", undefined, undefined);

    await new Promise((r) => setTimeout(r, 0));
    expect(hookRunner.runAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read",
        params: {},
      }),
      expect.objectContaining({
        toolName: "read",
        agentId: "main",
        sessionKey: "main",
      }),
    );
  });
});
