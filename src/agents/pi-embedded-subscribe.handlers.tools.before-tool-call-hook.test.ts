import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { handleToolExecutionStart } from "./pi-embedded-subscribe.handlers.tools.js";

// Mock dependencies
vi.mock("../plugins/hook-runner-global.js");
vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));
vi.mock("./pi-embedded-helpers.js");
vi.mock("./pi-embedded-messaging.js");
vi.mock("./pi-embedded-subscribe.tools.js");
vi.mock("./pi-embedded-utils.js", () => ({
  inferToolMetaFromArgs: vi.fn(() => undefined),
}));
vi.mock("./tool-policy.js", () => ({
  normalizeToolName: vi.fn((name: string) => name.toLowerCase()),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("before_tool_call hook integration", () => {
  let mockContext: EmbeddedPiSubscribeContext;
  let mockHookRunner: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock context
    mockContext = {
      params: {
        runId: "test-run-123",
        session: { key: "test-session" },
        onBlockReplyFlush: vi.fn(),
        onAgentEvent: vi.fn(),
      },
      state: {
        toolMetaById: {
          set: vi.fn(),
          get: vi.fn(),
          has: vi.fn(),
        },
      },
      log: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
      flushBlockReplyBuffer: vi.fn(),
      shouldEmitToolResult: vi.fn().mockReturnValue(true),
    } as any;

    // Mock hook runner
    mockHookRunner = {
      hasHooks: vi.fn(),
      runBeforeToolCall: vi.fn(),
    };

    mockGetGlobalHookRunner.mockReturnValue(mockHookRunner);
  });

  describe("when no hooks are registered", () => {
    beforeEach(() => {
      mockHookRunner.hasHooks.mockReturnValue(false);
    });

    it("should proceed with tool execution normally", async () => {
      const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
        type: "tool_start",
        toolName: "TestTool",
        toolCallId: "tool-call-123",
        args: { param: "value" },
      };

      // Should not throw
      await expect(handleToolExecutionStart(mockContext, event)).resolves.toBeUndefined();

      // Hook runner should check for hooks but not run them
      expect(mockHookRunner.hasHooks).toHaveBeenCalledWith("before_tool_call");
      expect(mockHookRunner.runBeforeToolCall).not.toHaveBeenCalled();
    });
  });

  describe("when hooks are registered", () => {
    beforeEach(() => {
      mockHookRunner.hasHooks.mockReturnValue(true);
    });

    it("should call the hook with correct parameters", async () => {
      mockHookRunner.runBeforeToolCall.mockResolvedValue(undefined);

      const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
        type: "tool_start",
        toolName: "TestTool",
        toolCallId: "tool-call-123",
        args: { param: "value" },
      };

      await handleToolExecutionStart(mockContext, event);

      expect(mockHookRunner.runBeforeToolCall).toHaveBeenCalledWith(
        {
          toolName: "testtool", // normalized
          params: { param: "value" },
        },
        {
          toolName: "testtool",
        },
      );
    });

    it("should allow hook to modify parameters", async () => {
      const modifiedParams = { param: "modified_value", newParam: "added" };
      mockHookRunner.runBeforeToolCall.mockResolvedValue({
        params: modifiedParams,
      });

      const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
        type: "tool_start",
        toolName: "TestTool",
        toolCallId: "tool-call-123",
        args: { param: "value" },
      };

      // The function should complete without error
      await expect(handleToolExecutionStart(mockContext, event)).resolves.toBeUndefined();

      expect(mockHookRunner.runBeforeToolCall).toHaveBeenCalledWith(
        {
          toolName: "testtool",
          params: { param: "value" },
        },
        {
          toolName: "testtool",
        },
      );

      // Hook should be called and parameter modification should work
      expect(mockHookRunner.runBeforeToolCall).toHaveBeenCalled();
    });

    it("should handle parameter modification with non-object args safely", async () => {
      const modifiedParams = { newParam: "replaced" };
      mockHookRunner.runBeforeToolCall.mockResolvedValue({
        params: modifiedParams,
      });

      const testCases = [
        { args: null, description: "null args" },
        { args: "string", description: "string args" },
        { args: 123, description: "number args" },
        { args: [1, 2, 3], description: "array args" },
      ];

      for (const { args, description } of testCases) {
        mockHookRunner.runBeforeToolCall.mockClear();

        const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
          type: "tool_start",
          toolName: "TestTool",
          toolCallId: `call-${description}`,
          args,
        };

        // Should not crash even with non-object args
        await expect(handleToolExecutionStart(mockContext, event)).resolves.toBeUndefined();

        // Hook should be called with normalized empty params
        expect(mockHookRunner.runBeforeToolCall).toHaveBeenCalledWith(
          {
            toolName: "testtool",
            params: {}, // Non-objects normalized to empty object
          },
          {
            toolName: "testtool",
          },
        );
      }
    });

    it("should block tool call when hook returns block=true", async () => {
      const blockReason = "Tool blocked by security policy";
      const mockResult = {
        block: true,
        blockReason,
      };

      mockHookRunner.runBeforeToolCall.mockResolvedValue(mockResult);

      const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
        type: "tool_start",
        toolName: "BlockedTool",
        toolCallId: "tool-call-456",
        args: { dangerous: "payload" },
      };

      // Should throw an error with the block reason
      await expect(handleToolExecutionStart(mockContext, event)).rejects.toThrow(blockReason);

      // Should log the block
      expect(mockContext.log.debug).toHaveBeenCalledWith(
        expect.stringContaining("Tool call blocked by plugin hook"),
      );
      expect(mockContext.log.debug).toHaveBeenCalledWith(expect.stringContaining(blockReason));

      // Should update internal state like normal tool flow
      expect(mockContext.state.toolMetaById.set).toHaveBeenCalled();
      expect(mockContext.params.onAgentEvent).toHaveBeenCalledWith({
        stream: "tool",
        data: { phase: "start", name: "blockedtool", toolCallId: "tool-call-456" },
      });
    });

    it("should block tool call with default reason when no blockReason provided", async () => {
      mockHookRunner.runBeforeToolCall.mockResolvedValue({
        block: true,
        // no blockReason
      });

      const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
        type: "tool_start",
        toolName: "BlockedTool",
        toolCallId: "tool-call-789",
        args: {},
      };

      // Should throw with default message
      await expect(handleToolExecutionStart(mockContext, event)).rejects.toThrow(
        "Tool call blocked by plugin hook",
      );
    });

    it("should handle hook errors gracefully and continue execution", async () => {
      const hookError = new Error("Hook implementation error");
      mockHookRunner.runBeforeToolCall.mockRejectedValue(hookError);

      const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
        type: "tool_start",
        toolName: "TestTool",
        toolCallId: "tool-call-999",
        args: { param: "value" },
      };

      // Should not throw - hook errors should be caught
      await expect(handleToolExecutionStart(mockContext, event)).resolves.toBeUndefined();

      // Should log the hook error
      expect(mockContext.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("before_tool_call hook failed"),
      );
      expect(mockContext.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Hook implementation error"),
      );
    });

    it("should re-throw blocking errors even when caught", async () => {
      const blockReason = "Blocked by security";
      mockHookRunner.runBeforeToolCall.mockResolvedValue({
        block: true,
        blockReason,
      });

      const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
        type: "tool_start",
        toolName: "TestTool",
        toolCallId: "tool-call-000",
        args: {},
      };

      // The blocking error should still be thrown
      await expect(handleToolExecutionStart(mockContext, event)).rejects.toThrow(blockReason);
    });
  });

  describe("hook context handling", () => {
    beforeEach(() => {
      mockHookRunner.hasHooks.mockReturnValue(true);
      mockHookRunner.runBeforeToolCall.mockResolvedValue(undefined);
    });

    it("should handle various tool name formats", async () => {
      const testCases = [
        { input: "ReadFile", expected: "readfile" },
        { input: "EXEC", expected: "exec" },
        { input: "bash-command", expected: "bash-command" },
        { input: " SpacedTool ", expected: " spacedtool " },
      ];

      for (const { input, expected } of testCases) {
        mockHookRunner.runBeforeToolCall.mockClear();

        const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
          type: "tool_start",
          toolName: input,
          toolCallId: `call-${input}`,
          args: {},
        };

        await handleToolExecutionStart(mockContext, event);

        expect(mockHookRunner.runBeforeToolCall).toHaveBeenCalledWith(
          {
            toolName: expected,
            params: {},
          },
          {
            toolName: expected,
          },
        );
      }
    });

    it("should handle different argument types", async () => {
      const testCases = [
        // Non-objects get normalized to {} for hook params (to maintain hook contract)
        { args: null, expectedParams: {} },
        { args: undefined, expectedParams: {} },
        { args: "string", expectedParams: {} },
        { args: 123, expectedParams: {} },
        { args: [1, 2, 3], expectedParams: {} }, // arrays are not plain objects
        // Only plain objects are passed through
        { args: { key: "value" }, expectedParams: { key: "value" } },
      ];

      for (const { args, expectedParams } of testCases) {
        mockHookRunner.runBeforeToolCall.mockClear();

        const event: AgentEvent & { toolName: string; toolCallId: string; args: unknown } = {
          type: "tool_start",
          toolName: "TestTool",
          toolCallId: `call-${typeof args}`,
          args,
        };

        await handleToolExecutionStart(mockContext, event);

        expect(mockHookRunner.runBeforeToolCall).toHaveBeenCalledWith(
          {
            toolName: "testtool",
            params: expectedParams,
          },
          {
            toolName: "testtool",
          },
        );
      }
    });
  });
});
