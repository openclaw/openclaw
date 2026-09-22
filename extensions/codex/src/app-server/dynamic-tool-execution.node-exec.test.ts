import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolCallResponse } from "./protocol.js";

const dynamicCallContext = { threadId: "thread-1", turnId: "turn-1", namespace: null };

describe("foreground node execution watchdog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { timeoutSeconds: undefined, executionTimeoutMs: 1_810_000, completionMs: 105_000 },
    { timeoutSeconds: 900, executionTimeoutMs: 910_000, completionMs: 690_000 },
    { timeoutSeconds: 0, executionTimeoutMs: 1_810_000, completionMs: 105_000 },
    {
      timeoutSeconds: Number.MAX_VALUE,
      executionTimeoutMs: 2_147_483_647,
      completionMs: 2_147_000_001,
    },
  ])(
    "preserves foreground node execution with timeoutSeconds=$timeoutSeconds",
    async ({ timeoutSeconds, executionTimeoutMs, completionMs }) => {
      vi.useFakeTimers();
      const call = {
        ...dynamicCallContext,
        callId: "call-node-exec",
        tool: "node_exec",
        arguments: {
          command: "long-command",
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        },
      };
      const getExecutionTimeoutMs = vi.fn(() => executionTimeoutMs);
      const completed: CodexDynamicToolCallResponse = {
        success: true,
        contentItems: [{ type: "inputText", text: "command completed" }],
      };
      const toolBridge = {
        availableTools: [
          {
            name: "node_exec",
            label: "node_exec",
            description: "Run a command on the node",
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
