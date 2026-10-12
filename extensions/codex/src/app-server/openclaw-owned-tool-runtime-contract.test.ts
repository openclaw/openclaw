import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  installCodexToolResultMiddleware,
  installOpenClawOwnedToolHooks,
  mediaToolResult,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { JsonObject } from "./protocol.js";

function createContractTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "exec",
    description: "Run a command.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

function createBridge(
  tool: AnyAgentTool,
  hookContext: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  return createCodexDynamicToolBridge({
    tools: [tool],
    signal: new AbortController().signal,
    hookContext,
  });
}

function toolCall(tool: string, callId: string, args: JsonObject) {
  return { threadId: "thread-1", turnId: "turn-1", callId, namespace: null, tool, arguments: args };
}

function expectExecuteCall(execute: unknown, callId: string, params: Record<string, unknown>) {
  expect(execute).toHaveBeenNthCalledWith(1, callId, params, expect.any(AbortSignal), undefined);
}

function expectAfterToolCall(
  hooks: ReturnType<typeof installOpenClawOwnedToolHooks>,
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) {
  expect(hooks.afterToolCall).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining(event),
    expect.objectContaining(context),
  );
}

describe("OpenClaw-owned tool runtime contract — Codex app-server adapter", () => {
  afterEach(() => {
    resetOpenClawOwnedToolHooks();
  });

  it("wraps dynamic tools with hooks and runs result middleware before the after hook", async () => {
    const mergedParams = { command: "status", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams: { mode: "safe" } });
    const middleware = installCodexToolResultMiddleware((event) => {
      expect(event).toMatchObject({
        toolName: "exec",
        toolCallId: "call-middleware",
      });
      expect(event.args).toEqual(mergedParams);
      expect(event.result.content).toEqual([{ type: "text", text: "raw output" }]);
      expect(event.result.details).toEqual({ stage: "execute" });
      return textToolResult("compacted output", { stage: "middleware" });
    });
    const execute = vi.fn(async () => textToolResult("raw output", { stage: "execute" }));
    const bridge = createBridge(createContractTool({ execute }), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-middleware",
    });
    const result = await bridge.handleToolCall(
      toolCall("exec", "call-middleware", { command: "status" }),
    );
    const context = {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-middleware",
      toolCallId: "call-middleware",
    };

    expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "compacted output" }],
    });
    expect(hooks.beforeToolCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "exec",
        toolCallId: "call-middleware",
        runId: "run-middleware",
        params: { command: "status" },
      }),
      expect.objectContaining(context),
    );
    expectExecuteCall(execute, "call-middleware", mergedParams);
    expect(middleware.middleware).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expectAfterToolCall(
        hooks,
        {
          toolName: "exec",
          toolCallId: "call-middleware",
          params: mergedParams,
          result: expect.objectContaining(
            textToolResult("compacted output", { stage: "middleware" }),
          ),
        },
        context,
      ),
    );
  });

  it("fails closed when before_tool_call blocks a dynamic tool", async () => {
    const hooks = installOpenClawOwnedToolHooks({ blockReason: "blocked by policy" });
    const execute = vi.fn(async () => textToolResult("should not run"));
    const bridge = createBridge(createContractTool({ name: "message", execute }), {
      runId: "run-blocked",
    });
    const params = { action: "send", text: "blocked", provider: "telegram", to: "chat-1" };
    const result = await bridge.handleToolCall(toolCall("message", "call-blocked", params));

    expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "blocked by policy" }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    await vi.waitFor(() =>
      expectAfterToolCall(
        hooks,
        {
          toolName: "message",
          toolCallId: "call-blocked",
          params,
          result: expect.objectContaining({
            content: [{ type: "text", text: "blocked by policy" }],
            details: {
              status: "blocked",
              deniedReason: "plugin-before-tool-call",
              reason: "blocked by policy",
            },
          }),
        },
        { runId: "run-blocked", toolCallId: "call-blocked" },
      ),
    );
  });

  it("reports dynamic tool execution errors through after_tool_call", async () => {
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams: { timeoutSec: 1 } });
    const mergedParams = { command: "false", timeoutSec: 1 };
    const execute = vi.fn(async () => {
      throw new Error("tool failed");
    });
    const bridge = createBridge(createContractTool({ execute }), { runId: "run-error" });
    const result = await bridge.handleToolCall(
      toolCall("exec", "call-error", { command: "false" }),
    );

    expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "tool failed" }],
    });
    expectExecuteCall(execute, "call-error", mergedParams);
    await vi.waitFor(() =>
      expectAfterToolCall(
        hooks,
        { toolName: "exec", toolCallId: "call-error", params: mergedParams, error: "tool failed" },
        { runId: "run-error", toolCallId: "call-error" },
      ),
    );
  });

  it("records successful Codex messaging text, media, and target telemetry", async () => {
    const hooks = installOpenClawOwnedToolHooks();
    const execute = vi.fn(async () => textToolResult("Sent.", { messageId: "message-1" }));
    const bridge = createBridge(createContractTool({ name: "message", execute }), {
      runId: "run-message",
    });
    const result = await bridge.handleToolCall(
      toolCall("message", "call-message", {
        action: "send",
        text: "hello from Codex",
        mediaUrl: "/tmp/codex-reply.png",
        provider: "telegram",
        to: "chat-1",
        threadId: "thread-ts-1",
      }),
    );

    expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Sent." }],
    });
    expect(bridge.telemetry).toMatchObject({
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["hello from Codex"],
      messagingToolSentMediaUrls: ["/tmp/codex-reply.png"],
    });
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-1",
        threadId: "thread-ts-1",
        text: "hello from Codex",
        mediaUrls: ["/tmp/codex-reply.png"],
      },
    ]);
    await vi.waitFor(() =>
      expectAfterToolCall(
        hooks,
        {
          toolName: "message",
          toolCallId: "call-message",
          params: expect.objectContaining({
            text: "hello from Codex",
            mediaUrl: "/tmp/codex-reply.png",
          }),
        },
        { runId: "run-message", toolCallId: "call-message" },
      ),
    );
  });

  it("records successful Codex media artifacts from tool results", async () => {
    const hooks = installOpenClawOwnedToolHooks();
    const execute = vi.fn(async () =>
      mediaToolResult("Generated media reply.", "/tmp/reply.opus", true),
    );
    const bridge = createBridge(createContractTool({ name: "tts", execute }), {
      runId: "run-media",
    });
    const result = await bridge.handleToolCall(toolCall("tts", "call-media", { text: "hello" }));

    expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Generated media reply." }],
    });
    expect(bridge.telemetry.toolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(bridge.telemetry.toolAudioAsVoice).toBe(true);
    await vi.waitFor(() =>
      expectAfterToolCall(
        hooks,
        {
          toolName: "tts",
          toolCallId: "call-media",
          result: expect.objectContaining({
            details: expect.objectContaining({
              media: expect.objectContaining({ mediaUrl: "/tmp/reply.opus", audioAsVoice: true }),
            }),
          }),
        },
        { runId: "run-media", toolCallId: "call-media" },
      ),
    );
  });

  it("does not double-wrap dynamic tools that already have before_tool_call", async () => {
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams: { mode: "safe" } });
    const execute = vi.fn(async () => textToolResult("done"));
    const tool = wrapToolWithBeforeToolCallHook(createContractTool({ execute }), {
      runId: "run-wrapped",
    });
    const bridge = createBridge(tool, { runId: "run-wrapped" });
    const result = await bridge.handleToolCall(
      toolCall("exec", "call-wrapped", { command: "pwd" }),
    );

    expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "done" }],
    });
    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expectExecuteCall(execute, "call-wrapped", { command: "pwd", mode: "safe" });
  });
});
