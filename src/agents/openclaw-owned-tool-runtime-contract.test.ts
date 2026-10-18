// Verifies OpenClaw-owned tool hooks preserve adjusted params and telemetry.
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import {
  installOpenClawOwnedToolHooks,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { createBaseToolHandlerState } from "./agent-tool-handler-state.test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import { prepareToolResult } from "./embedded-agent-tool-results.js";

function createContractTool(name: string, execute: AgentTool["execute"]): AgentTool {
  return {
    name,
    label: name,
    description: `contract tool: ${name}`,
    parameters: { type: "object", properties: {} },
    execute,
  } as AgentTool;
}

type ToolExecutionStartEvent = Parameters<typeof handleToolExecutionStart>[1];
type ToolExecutionEndEvent = Parameters<typeof handleToolExecutionEnd>[1];

const session = {
  agentId: "agent-1",
  sessionId: "session-1",
  sessionKey: "agent:agent-1:session-1",
};

function createToolHandlerCtx(runId: string): ToolHandlerContext {
  // Minimal embedded-agent tool handler context used to drive start/end events.
  return {
    params: { ...session, runId },
    state: createBaseToolHandlerState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
}

async function startContract(
  toolName: string,
  execute: AgentTool["execute"],
  args: Record<string, unknown>,
  suffix: string,
) {
  const runId = `run-${suffix}`;
  const toolCallId = `call-${suffix}`;
  const tool = wrapToolWithBeforeToolCallHook(createContractTool(toolName, execute), {
    ...session,
    runId,
  });
  const definition = toToolDefinitions([tool])[0];
  if (!definition) {
    throw new Error("missing embedded agent tool definition");
  }
  const ctx = createToolHandlerCtx(runId);
  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    toolName,
    toolCallId,
    args,
  } as ToolExecutionStartEvent);
  const result = await definition.execute(
    toolCallId,
    args,
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  return {
    ctx,
    result,
    toolCallId,
    finish: (isError = false) =>
      handleToolExecutionEnd(
        ctx,
        {
          type: "tool_execution_end",
          toolName,
          toolCallId,
          isError,
          result,
        } as ToolExecutionEndEvent,
        prepareToolResult(result),
      ),
  };
}

async function expectAfterToolCall(
  hooks: ReturnType<typeof installOpenClawOwnedToolHooks>,
  payload: Record<string, unknown>,
  context: Record<string, unknown>,
) {
  // after_tool_call fires asynchronously after the execution-end event is processed.
  await vi.waitFor(() => {
    expect(hooks.afterToolCall).toHaveBeenCalledTimes(1);
    expect(hooks.afterToolCall).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      expect.objectContaining(context),
    );
  });
}

describe("OpenClaw-owned tool runtime contract - embedded agent adapter", () => {
  afterEach(resetOpenClawOwnedToolHooks);

  it("preserves partially adjusted before_tool_call params through execution and after_tool_call", async () => {
    const adjustedParams = { mode: "safe" };
    const mergedParams = { command: "pwd", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => textToolResult("done", { ok: true }));
    const { toolCallId, finish } = await startContract(
      "exec",
      execute,
      { command: "pwd" },
      "contract",
    );
    await finish();

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(toolCallId, mergedParams, undefined, undefined);
    await expectAfterToolCall(
      hooks,
      {
        toolName: "exec",
        toolCallId,
        params: mergedParams,
        result: { content: [{ type: "text", text: "done" }], details: { ok: true } },
      },
      { ...session, runId: "run-contract", toolCallId },
    );
  });

  it("reports embedded agent dynamic tool execution errors through after_tool_call", async () => {
    const adjustedParams = { timeoutSec: 1 };
    const mergedParams = { command: "false", timeoutSec: 1 };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => {
      throw new Error("tool failed");
    });
    const { result, toolCallId, finish } = await startContract(
      "exec",
      execute,
      { command: "false" },
      "error",
    );
    const resultDetails = (result as { details?: Record<string, unknown> }).details;
    expect(resultDetails).toMatchObject({ status: "error", error: "tool failed" });
    await finish(true);

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(toolCallId, mergedParams, undefined, undefined);
    await expectAfterToolCall(
      hooks,
      {
        toolName: "exec",
        toolCallId,
        params: mergedParams,
        error: "tool failed",
      },
      { runId: "run-error", toolCallId },
    );
  });

  it("commits successful embedded agent messaging text, media, and target telemetry", async () => {
    const hooks = installOpenClawOwnedToolHooks();
    const execute = vi.fn(async () => textToolResult("sent", { deliveryStatus: "sent" }));
    const originalParams = {
      action: "send",
      content: "hello from embedded agent",
      mediaUrl: "/tmp/openclaw-reply.png",
      provider: "telegram",
      to: "chat-1",
    };

    const { ctx, toolCallId, finish } = await startContract(
      "message",
      execute,
      originalParams,
      "message",
    );
    await finish();

    expect(ctx.state.messagingToolSentTexts).toEqual(["hello from embedded agent"]);
    expect(ctx.state.messagingToolSentMediaUrls).toEqual(["/tmp/openclaw-reply.png"]);
    expect(ctx.state.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat-1",
        text: "hello from embedded agent",
        mediaUrls: ["/tmp/openclaw-reply.png"],
      }),
    ]);
    await expectAfterToolCall(
      hooks,
      {
        toolName: "message",
        toolCallId,
        params: originalParams,
        result: expect.objectContaining({ content: [{ type: "text", text: "sent" }] }),
      },
      { runId: "run-message", toolCallId },
    );
  });

  it("fails closed when before_tool_call blocks an embedded agent dynamic tool", async () => {
    const hooks = installOpenClawOwnedToolHooks({ blockReason: "blocked by policy" });
    const execute = vi.fn(async () => textToolResult("should not run"));
    const originalParams = {
      action: "send",
      text: "blocked",
      provider: "telegram",
      to: "chat-1",
    };

    const { result, toolCallId, finish } = await startContract(
      "message",
      execute,
      originalParams,
      "blocked",
    );
    const resultDetails = (result as { details?: Record<string, unknown> }).details;
    expect(resultDetails).toMatchObject({
      status: "blocked",
      deniedReason: "plugin-before-tool-call",
      reason: "blocked by policy",
    });
    await finish(true);

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    await expectAfterToolCall(
      hooks,
      {
        toolName: "message",
        toolCallId,
        params: originalParams,
        result: {
          content: [{ type: "text", text: "blocked by policy" }],
          details: {
            status: "blocked",
            deniedReason: "plugin-before-tool-call",
            reason: "blocked by policy",
          },
        },
        error: "blocked by policy",
      },
      { ...session, runId: "run-blocked", toolCallId },
    );
  });
});
