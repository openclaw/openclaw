import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../../../../src/agents/pi-tools.before-tool-call.js";
import {
  installCodexToolResultMiddleware,
  installOpenClawOwnedToolHooks,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "../../../../test/helpers/agents/openclaw-owned-tool-runtime-contract.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

function createContractTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "exec",
    description: "Run a command.",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

describe("OpenClaw-owned tool runtime contract — Codex app-server adapter", () => {
  afterEach(() => {
    resetOpenClawOwnedToolHooks();
  });

  it("wraps unwrapped dynamic tools with before/after tool hooks", async () => {
    const adjustedParams = { command: "pwd", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => textToolResult("done", { ok: true }));
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-contract",
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-contract",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "done" }],
    });
    expect(hooks.beforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        toolCallId: "call-contract",
        runId: "run-contract",
        params: { command: "pwd" },
      }),
      expect.objectContaining({
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-contract",
        toolCallId: "call-contract",
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      "call-contract",
      adjustedParams,
      expect.any(AbortSignal),
      undefined,
    );
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-contract",
          params: adjustedParams,
          result: expect.objectContaining({
            content: [{ type: "text", text: "done" }],
            details: { ok: true },
          }),
        }),
        expect.objectContaining({
          agentId: "agent-1",
          sessionId: "session-1",
          sessionKey: "agent:agent-1:session-1",
          runId: "run-contract",
          toolCallId: "call-contract",
        }),
      );
    });
  });

  it("runs tool_result middleware before after_tool_call observes the result", async () => {
    const adjustedParams = { command: "status", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const middleware = installCodexToolResultMiddleware((event) => {
      expect(event).toMatchObject({
        toolName: "exec",
        toolCallId: "call-middleware",
        args: { command: "status" },
        result: {
          content: [{ type: "text", text: "raw output" }],
          details: { stage: "execute" },
        },
      });
      return textToolResult("compacted output", { stage: "middleware" });
    });
    const execute = vi.fn(async () => textToolResult("raw output", { stage: "execute" }));
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        runId: "run-middleware",
      },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-middleware",
      namespace: null,
      tool: "exec",
      arguments: { command: "status" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "compacted output" }],
    });
    expect(execute).toHaveBeenCalledWith(
      "call-middleware",
      adjustedParams,
      expect.any(AbortSignal),
      undefined,
    );
    expect(middleware.middleware).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-middleware",
          params: adjustedParams,
          result: expect.objectContaining({
            content: [{ type: "text", text: "compacted output" }],
            details: { stage: "middleware" },
          }),
        }),
        expect.objectContaining({
          runId: "run-middleware",
          toolCallId: "call-middleware",
        }),
      );
    });
  });

  it("fails closed when before_tool_call blocks a dynamic tool", async () => {
    const hooks = installOpenClawOwnedToolHooks({ blockReason: "blocked by policy" });
    const execute = vi.fn(async () => textToolResult("should not run"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "message", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-blocked" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-blocked",
      namespace: null,
      tool: "message",
      arguments: {
        action: "send",
        text: "blocked",
        provider: "telegram",
        to: "chat-1",
      },
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "blocked by policy" }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "message",
          toolCallId: "call-blocked",
          params: {
            action: "send",
            text: "blocked",
            provider: "telegram",
            to: "chat-1",
          },
          error: "blocked by policy",
        }),
        expect.objectContaining({
          runId: "run-blocked",
          toolCallId: "call-blocked",
        }),
      );
    });
  });

  it("reports dynamic tool execution errors through after_tool_call", async () => {
    const adjustedParams = { command: "false", timeoutSec: 1 };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => {
      throw new Error("tool failed");
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [createContractTool({ name: "exec", execute })],
      signal: new AbortController().signal,
      hookContext: { runId: "run-error" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-error",
      namespace: null,
      tool: "exec",
      arguments: { command: "false" },
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "tool failed" }],
    });
    expect(execute).toHaveBeenCalledWith(
      "call-error",
      adjustedParams,
      expect.any(AbortSignal),
      undefined,
    );
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-error",
          params: adjustedParams,
          error: "tool failed",
        }),
        expect.objectContaining({
          runId: "run-error",
          toolCallId: "call-error",
        }),
      );
    });
  });

  it("does not double-wrap dynamic tools that already have before_tool_call", async () => {
    const adjustedParams = { command: "pwd", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => textToolResult("done"));
    const tool = wrapToolWithBeforeToolCallHook(createContractTool({ name: "exec", execute }), {
      runId: "run-wrapped",
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
      hookContext: { runId: "run-wrapped" },
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-wrapped",
      namespace: null,
      tool: "exec",
      arguments: { command: "pwd" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "done" }],
    });
    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "call-wrapped",
      adjustedParams,
      expect.any(AbortSignal),
      undefined,
    );
  });
});
