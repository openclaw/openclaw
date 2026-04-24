import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
});
