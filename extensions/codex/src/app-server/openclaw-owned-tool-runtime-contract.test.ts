import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  installCodexToolResultMiddleware,
  installOpenClawOwnedToolHooks,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { JsonObject } from "./protocol.js";

const callId = "call-contract";
const hookContext = { runId: "run-contract" };
const context = { ...hookContext, toolCallId: callId };
const frame = { threadId: "thread-1", turnId: "turn-1", callId, namespace: null };

function toolFixture(
  result: ReturnType<typeof textToolResult> | Error,
  hookOptions: Parameters<typeof installOpenClawOwnedToolHooks>[0] = {},
  {
    name = "exec",
    providedContext = hookContext,
    wrapped = false,
    middleware: middlewareHandler,
  }: {
    name?: string;
    providedContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"];
    wrapped?: boolean;
    middleware?: Parameters<typeof installCodexToolResultMiddleware>[0];
  } = {},
) {
  const hooks = installOpenClawOwnedToolHooks(hookOptions);
  const middleware = middlewareHandler && installCodexToolResultMiddleware(middlewareHandler);
  const execute = vi.fn(async () => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  const tool = {
    name,
    description: "Run a command.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute,
  } as unknown as AnyAgentTool;
  const bridge = createCodexDynamicToolBridge({
    tools: [wrapped ? wrapToolWithBeforeToolCallHook(tool, providedContext) : tool],
    signal: new AbortController().signal,
    hookContext: providedContext,
  });
  const invoke = async (args: JsonObject) =>
    toCodexDynamicToolProtocolResponse(
      await bridge.handleToolCall({ ...frame, tool: name, arguments: args }),
    );
  return { hooks, execute, bridge, invoke, middleware };
}
function expectExecuteCall(execute: unknown, params: Record<string, unknown>) {
  expect(execute).toHaveBeenNthCalledWith(1, callId, params, expect.any(AbortSignal), undefined);
}
async function expectAfterToolCall(
  hooks: ReturnType<typeof installOpenClawOwnedToolHooks>,
  event: Record<string, unknown>,
  expectedContext: Record<string, unknown> = context,
) {
  await vi.waitFor(() =>
    expect(hooks.afterToolCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toolCallId: callId, ...event }),
      expect.objectContaining(expectedContext),
    ),
  );
}
function expectResponse(
  result: ReturnType<typeof toCodexDynamicToolProtocolResponse>,
  success: boolean,
  text: string,
) {
  expect(result).toEqual({ success, contentItems: [{ type: "inputText", text }] });
}

describe("OpenClaw-owned tool runtime contract — Codex app-server adapter", () => {
  afterEach(resetOpenClawOwnedToolHooks);

  it("wraps dynamic tools with hooks and runs result middleware before the after hook", async () => {
    const mergedParams = { command: "status", mode: "safe" };

    const agentContext = {
      ...hookContext,
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    };
    const { hooks, execute, invoke, middleware } = toolFixture(
      textToolResult("raw output", { stage: "execute" }),
      { adjustedParams: { mode: "safe" } },
      {
        providedContext: agentContext,
        middleware: (event) => {
          expect(event).toMatchObject({ toolName: "exec", toolCallId: callId });
          expect(event.args).toEqual(mergedParams);
          expect(event.result.content).toEqual([{ type: "text", text: "raw output" }]);
          expect(event.result.details).toEqual({ stage: "execute" });
          return textToolResult("compacted output", { stage: "middleware" });
        },
      },
    );
    const result = await invoke({ command: "status" });
    const expectedContext = { ...agentContext, toolCallId: callId };
    expectResponse(result, true, "compacted output");
    expect(hooks.beforeToolCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolName: "exec",
        toolCallId: callId,
        runId: hookContext.runId,
        params: { command: "status" },
      }),
      expect.objectContaining(expectedContext),
    );
    expectExecuteCall(execute, mergedParams);
    expect(middleware?.middleware).toHaveBeenCalledTimes(1);
    await expectAfterToolCall(
      hooks,
      {
        toolName: "exec",
        params: mergedParams,
        result: expect.objectContaining(
          textToolResult("compacted output", { stage: "middleware" }),
        ),
      },
      expectedContext,
    );
  });

  it("fails closed when before_tool_call blocks a dynamic tool", async () => {
    const { hooks, execute, bridge, invoke } = toolFixture(
      textToolResult("should not run"),
      { blockReason: "blocked by policy" },
      { name: "message" },
    );
    const params = { action: "send", text: "blocked", provider: "telegram", to: "chat-1" };
    expectResponse(await invoke(params), false, "blocked by policy");
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
    await expectAfterToolCall(hooks, {
      toolName: "message",
      params,
      result: expect.objectContaining({
        content: [{ type: "text", text: "blocked by policy" }],
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      }),
    });
  });

  it("reports dynamic tool execution errors through after_tool_call", async () => {
    const { hooks, execute, invoke } = toolFixture(new Error("tool failed"), {
      adjustedParams: { timeoutSec: 1 },
    });
    const mergedParams = { command: "false", timeoutSec: 1 };
    expectResponse(await invoke({ command: "false" }), false, "tool failed");
    expectExecuteCall(execute, mergedParams);
    await expectAfterToolCall(hooks, {
      toolName: "exec",
      params: mergedParams,
      error: "tool failed",
    });
  });

  it("records successful Codex messaging text, media, and target telemetry", async () => {
    const { hooks, bridge, invoke } = toolFixture(
      textToolResult("Sent.", { messageId: "message-1" }),
      {},
      { name: "message" },
    );
    const target = {
      provider: "telegram",
      to: "chat-1",
      threadId: "thread-ts-1",
      text: "hello from Codex",
    };
    const mediaUrl = "/tmp/codex-reply.png";
    expectResponse(await invoke({ ...target, action: "send", mediaUrl }), true, "Sent.");
    expect(bridge.telemetry).toMatchObject({
      didSendViaMessagingTool: true,
      messagingToolSentTexts: [target.text],
      messagingToolSentMediaUrls: [mediaUrl],
    });
    expect(bridge.telemetry.messagingToolSentTargets).toEqual([
      { tool: "message", ...target, mediaUrls: [mediaUrl] },
    ]);
    await expectAfterToolCall(hooks, {
      toolName: "message",
      params: expect.objectContaining({ text: target.text, mediaUrl }),
    });
  });

  it("does not double-wrap dynamic tools that already have before_tool_call", async () => {
    const { hooks, execute, invoke } = toolFixture(
      textToolResult("done"),
      { adjustedParams: { mode: "safe" } },
      { wrapped: true },
    );
    expectResponse(await invoke({ command: "pwd" }), true, "done");
    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expectExecuteCall(execute, { command: "pwd", mode: "safe" });
  });
});
