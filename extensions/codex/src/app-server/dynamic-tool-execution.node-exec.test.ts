import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

const dynamicCallContext = { threadId: "thread-1", turnId: "turn-1", namespace: null };

describe("tool-owned execution watchdog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each<
    Pick<CodexDynamicToolCallParams, "tool" | "arguments"> & {
      executionTimeoutMs: number;
      completionMs: number;
    }
  >([
    {
      tool: "node_exec",
      arguments: { command: "long-command", timeoutSeconds: 900 },
      executionTimeoutMs: 910_000,
      completionMs: 690_000,
    },
    {
      tool: "node_exec",
      arguments: { command: "long-command", timeoutSeconds: Number.MAX_VALUE },
      executionTimeoutMs: 2_147_483_647,
      completionMs: 2_147_000_001,
    },
    {
      tool: "automations",
      arguments: { action: "run", jobId: "job", runMode: "force", timeoutMs: 1_000 },
      executionTimeoutMs: 61_000,
      completionMs: 1_500,
    },
  ])(
    "preserves $tool execution through its owned completion budget",
    async ({ tool, arguments: toolArguments, executionTimeoutMs, completionMs }) => {
      vi.useFakeTimers();
      const call: CodexDynamicToolCallParams = {
        ...dynamicCallContext,
        callId: "call-tool-owned-budget",
        tool,
        arguments: toolArguments,
      };
      const getExecutionTimeoutMs = vi.fn(() => executionTimeoutMs);
      const completed: CodexDynamicToolCallResponse = {
        success: true,
        contentItems: [{ type: "inputText", text: "tool completed" }],
      };
      const toolBridge = {
        availableTools: [
          {
            name: tool,
            label: tool,
            description: "Run with a tool-owned execution budget",
            parameters: {},
            execute: vi.fn(),
            getExecutionTimeoutMs,
          },
        ],
        handleToolCall: () =>
          new Promise<CodexDynamicToolCallResponse>((resolve) => {
            setTimeout(() => resolve(completed), completionMs);
          }),
      };
      const response = handleDynamicToolCallWithTimeout({
        call,
        toolBridge,
        signal: new AbortController().signal,
        timeoutMs: resolveDynamicToolCallTimeoutMs({ call, config: undefined, toolBridge }),
      });

      await vi.advanceTimersByTimeAsync(completionMs);

      await expect(response).resolves.toEqual(completed);
      expect(getExecutionTimeoutMs).toHaveBeenCalledExactlyOnceWith(call.arguments);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
