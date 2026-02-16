import type { AgentTool } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

// Mock the global hook runner
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

// Mock logger to verify warning messages
vi.mock("../logger.js", async () => {
  const actual = await vi.importActual("../logger.js");
  return {
    ...actual,
    logWarn: vi.fn(),
  };
});

import { logWarn } from "../logger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockLogWarn = vi.mocked(logWarn);

function makeTool(
  overrides: Partial<AgentTool<unknown, unknown>> = {},
): AgentTool<unknown, unknown> {
  return {
    name: "test-tool",
    label: "Test",
    description: "test",
    parameters: {},
    execute: async () => ({ details: { ok: true }, resultForAssistant: "ok" }),
    ...overrides,
  };
}

function mockHookRunner(opts: {
  hooks?: string[];
  runBeforeToolCall?: (event: any, ctx: any) => Promise<any>;
  runAfterToolCall?: (event: any, ctx: any) => Promise<void>;
}) {
  const hasHooks = (name: string) => (opts.hooks ?? []).includes(name);
  return {
    hasHooks,
    runBeforeToolCall: vi.fn(opts.runBeforeToolCall ?? (async () => undefined)),
    runAfterToolCall: vi.fn(opts.runAfterToolCall ?? (async () => {})),
  };
}

describe("pi tool definition adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps tool errors into a tool result", async () => {
    mockGetGlobalHookRunner.mockReturnValue(null);
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call1", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    mockGetGlobalHookRunner.mockReturnValue(null);
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call2", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  // =========================================================================
  // before_tool_call hook tests
  // =========================================================================

  describe("before_tool_call hook", () => {
    it("blocks tool execution when hook returns block: true", async () => {
      const executeSpy = vi.fn(async () => ({ details: { ok: true }, resultForAssistant: "ok" }));
      const tool = makeTool({ name: "exec", execute: executeSpy });

      const runner = mockHookRunner({
        hooks: ["before_tool_call"],
        runBeforeToolCall: async () => ({
          block: true,
          blockReason: "Security policy: blocked",
        }),
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const defs = toToolDefinitions([tool], { agentId: "main", sessionKey: "main:abc" });
      const result = await defs[0].execute("call1", { command: "gog inbox" }, undefined, undefined);

      expect(executeSpy).not.toHaveBeenCalled();
      expect(result.details).toMatchObject({
        status: "blocked",
        tool: "exec",
        error: "Security policy: blocked",
      });
    });

    it("allows tool execution when hook does not block", async () => {
      const executeSpy = vi.fn(async () => ({
        details: { ran: true },
        resultForAssistant: "done",
      }));
      const tool = makeTool({ name: "read", execute: executeSpy });

      const runner = mockHookRunner({
        hooks: ["before_tool_call"],
        runBeforeToolCall: async () => undefined,
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const defs = toToolDefinitions([tool], { agentId: "main" });
      const result = await defs[0].execute("call1", { path: "/tmp/f" }, undefined, undefined);

      expect(executeSpy).toHaveBeenCalled();
      expect(result.details).toMatchObject({ ran: true });
    });

    it("passes modified params from hook to tool.execute", async () => {
      const executeSpy = vi.fn(async (_id: string, params: unknown) => ({
        details: { params },
        resultForAssistant: "ok",
      }));
      const tool = makeTool({ name: "exec", execute: executeSpy });

      const runner = mockHookRunner({
        hooks: ["before_tool_call"],
        runBeforeToolCall: async () => ({
          params: { command: "echo safe" },
        }),
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const defs = toToolDefinitions([tool], { agentId: "main" });
      await defs[0].execute("call1", { command: "rm -rf /" }, undefined, undefined);

      expect(executeSpy).toHaveBeenCalledWith(
        "call1",
        { command: "echo safe" },
        undefined,
        undefined,
      );
    });

    it("provides correct context to before_tool_call hook", async () => {
      const runner = mockHookRunner({ hooks: ["before_tool_call"] });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({ name: "exec" });
      const defs = toToolDefinitions([tool], { agentId: "reader", sessionKey: "reader:xyz" });
      await defs[0].execute("call1", { command: "ls" }, undefined, undefined);

      expect(runner.runBeforeToolCall).toHaveBeenCalledWith(
        { toolName: "exec", params: { command: "ls" } },
        { agentId: "reader", sessionKey: "reader:xyz", toolName: "exec" },
      );
    });

    it("logs warning when before_tool_call hook throws", async () => {
      const runner = mockHookRunner({
        hooks: ["before_tool_call"],
        runBeforeToolCall: async () => {
          throw new Error("hook exploded");
        },
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({ name: "exec" });
      const defs = toToolDefinitions([tool], { agentId: "main" });
      const result = await defs[0].execute("call1", { command: "ls" }, undefined, undefined);

      // Tool should still execute despite hook error
      expect(result.details).toMatchObject({ ok: true });
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("before_tool_call hook error for exec"),
      );
    });

    it("uses default blockReason when hook blocks without reason", async () => {
      const runner = mockHookRunner({
        hooks: ["before_tool_call"],
        runBeforeToolCall: async () => ({ block: true }),
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({ name: "exec" });
      const defs = toToolDefinitions([tool], { agentId: "main" });
      const result = await defs[0].execute("call1", {}, undefined, undefined);

      expect(result.details).toMatchObject({
        status: "blocked",
        error: "Blocked by plugin hook",
      });
    });

    it("does not block when hook returns block: false explicitly", async () => {
      const executeSpy = vi.fn(async () => ({
        details: { ok: true },
        resultForAssistant: "ok",
      }));
      const tool = makeTool({ name: "exec", execute: executeSpy });

      const runner = mockHookRunner({
        hooks: ["before_tool_call"],
        runBeforeToolCall: async () => ({ block: false }),
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const defs = toToolDefinitions([tool], { agentId: "main" });
      await defs[0].execute("call1", {}, undefined, undefined);

      expect(executeSpy).toHaveBeenCalled();
    });

    it("normalizes tool name (bash → exec) in hook events", async () => {
      const runner = mockHookRunner({ hooks: ["before_tool_call"] });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({ name: "bash" });
      const defs = toToolDefinitions([tool], { agentId: "main" });
      await defs[0].execute("call1", {}, undefined, undefined);

      expect(runner.runBeforeToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "exec" }),
        expect.objectContaining({ toolName: "exec" }),
      );
    });
  });

  // =========================================================================
  // after_tool_call hook tests
  // =========================================================================

  describe("after_tool_call hook", () => {
    it("fires after_tool_call on successful execution with result and duration", async () => {
      const runner = mockHookRunner({ hooks: ["after_tool_call"] });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({
        name: "read",
        execute: async () => ({ details: { content: "hello" }, resultForAssistant: "hello" }),
      });

      const defs = toToolDefinitions([tool], { agentId: "main" });
      await defs[0].execute("call1", { path: "/tmp/f" }, undefined, undefined);

      // Wait for the fire-and-forget promise
      await new Promise((r) => setTimeout(r, 10));

      expect(runner.runAfterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "read",
          params: { path: "/tmp/f" },
          result: { content: "hello" },
        }),
        expect.objectContaining({ agentId: "main", toolName: "read" }),
      );
      // durationMs should be a non-negative number
      const event = runner.runAfterToolCall.mock.calls[0][0];
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof event.durationMs).toBe("number");
    });

    it("fires after_tool_call on error path with error message", async () => {
      const runner = mockHookRunner({ hooks: ["after_tool_call"] });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({
        name: "exec",
        execute: async () => {
          throw new Error("boom");
        },
      });

      const defs = toToolDefinitions([tool], { agentId: "main" });
      await defs[0].execute("call1", { command: "fail" }, undefined, undefined);

      await new Promise((r) => setTimeout(r, 10));

      expect(runner.runAfterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          error: "boom",
        }),
        expect.objectContaining({ agentId: "main", toolName: "exec" }),
      );
      // Error path should not include result
      const event = runner.runAfterToolCall.mock.calls[0][0];
      expect(event.result).toBeUndefined();
    });

    it("does NOT fire after_tool_call when before_tool_call blocks", async () => {
      const runner = mockHookRunner({
        hooks: ["before_tool_call", "after_tool_call"],
        runBeforeToolCall: async () => ({
          block: true,
          blockReason: "denied",
        }),
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({ name: "exec" });
      const defs = toToolDefinitions([tool], { agentId: "main" });
      await defs[0].execute("call1", { command: "gog" }, undefined, undefined);

      await new Promise((r) => setTimeout(r, 10));

      // after_tool_call should NOT be called — execution was blocked before it started
      expect(runner.runAfterToolCall).not.toHaveBeenCalled();
    });

    it("swallows after_tool_call rejection without breaking execution", async () => {
      const runner = mockHookRunner({
        hooks: ["after_tool_call"],
        runAfterToolCall: async () => {
          throw new Error("after hook exploded");
        },
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({
        name: "read",
        execute: async () => ({ details: { ok: true }, resultForAssistant: "ok" }),
      });

      const defs = toToolDefinitions([tool], { agentId: "main" });
      // Should not throw despite after_tool_call rejecting
      const result = await defs[0].execute("call1", {}, undefined, undefined);

      await new Promise((r) => setTimeout(r, 10));

      expect(result.details).toMatchObject({ ok: true });
      // Warning should be logged about the hook error
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("after_tool_call hook error for read"),
      );
    });

    it("swallows after_tool_call rejection on error path too", async () => {
      const runner = mockHookRunner({
        hooks: ["after_tool_call"],
        runAfterToolCall: async () => {
          throw new Error("after hook exploded");
        },
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({
        name: "exec",
        execute: async () => {
          throw new Error("tool failed");
        },
      });

      const defs = toToolDefinitions([tool], { agentId: "main" });
      // Should return error result, not throw
      const result = await defs[0].execute("call1", {}, undefined, undefined);

      await new Promise((r) => setTimeout(r, 10));

      expect(result.details).toMatchObject({ status: "error", error: "tool failed" });
    });
  });

  // =========================================================================
  // Hook runner exists but has no relevant hooks
  // =========================================================================

  describe("hook runner with no matching hooks", () => {
    it("skips before_tool_call when hasHooks returns false", async () => {
      const runner = mockHookRunner({ hooks: [] }); // no hooks registered
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const executeSpy = vi.fn(async () => ({
        details: { ran: true },
        resultForAssistant: "ok",
      }));
      const tool = makeTool({ name: "exec", execute: executeSpy });

      const defs = toToolDefinitions([tool], { agentId: "main" });
      await defs[0].execute("call1", { command: "ls" }, undefined, undefined);

      expect(executeSpy).toHaveBeenCalled();
      expect(runner.runBeforeToolCall).not.toHaveBeenCalled();
      expect(runner.runAfterToolCall).not.toHaveBeenCalled();
    });

    it("skips after_tool_call when only before_tool_call is registered", async () => {
      const runner = mockHookRunner({
        hooks: ["before_tool_call"], // only before, not after
      });
      mockGetGlobalHookRunner.mockReturnValue(runner as any);

      const tool = makeTool({ name: "read" });
      const defs = toToolDefinitions([tool], { agentId: "main" });
      await defs[0].execute("call1", {}, undefined, undefined);

      await new Promise((r) => setTimeout(r, 10));

      expect(runner.runBeforeToolCall).toHaveBeenCalled();
      expect(runner.runAfterToolCall).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // No hook runner (null) — backwards compatibility
  // =========================================================================

  describe("without hook runner", () => {
    it("executes normally when no hook runner is available", async () => {
      mockGetGlobalHookRunner.mockReturnValue(null);

      const tool = makeTool({
        name: "read",
        execute: async () => ({ details: { ok: true }, resultForAssistant: "ok" }),
      });

      const defs = toToolDefinitions([tool]);
      const result = await defs[0].execute("call1", {}, undefined, undefined);
      expect(result.details).toMatchObject({ ok: true });
    });

    it("executes normally when hookCtx is not provided", async () => {
      mockGetGlobalHookRunner.mockReturnValue(null);

      const tool = makeTool();
      const defs = toToolDefinitions([tool]);
      const result = await defs[0].execute("call1", {}, undefined, undefined);
      expect(result.details).toMatchObject({ ok: true });
    });
  });
});
