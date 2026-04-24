import type { AgentTool } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installOpenClawOwnedToolHooks,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "../../test/helpers/agents/openclaw-owned-tool-runtime-contract.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { createBaseToolHandlerState } from "./pi-tool-handler-state.test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

function createContractTool(name: string, execute: AgentTool["execute"]): AgentTool {
  return {
    name,
    label: name,
    description: `contract tool: ${name}`,
    parameters: { type: "object", properties: {} },
    execute,
  } as AgentTool;
}

function createToolHandlerCtx() {
  return {
    params: {
      runId: "run-contract",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      session: { messages: [] },
    },
    state: {
      ...createBaseToolHandlerState(),
      successfulCronAdds: 0,
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
}

describe("OpenClaw-owned tool runtime contract — Pi adapter", () => {
  afterEach(() => {
    resetOpenClawOwnedToolHooks();
  });

  it("preserves partially adjusted before_tool_call params through execution and after_tool_call", async () => {
    const adjustedParams = { mode: "safe" };
    const mergedParams = { command: "pwd", mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => textToolResult("done", { ok: true }));
    const tool = wrapToolWithBeforeToolCallHook(createContractTool("exec", execute), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-contract",
    });
    const definition = toToolDefinitions([tool])[0];
    if (!definition) {
      throw new Error("missing Pi tool definition");
    }
    const ctx = createToolHandlerCtx();
    const toolCallId = "call-contract";
    const originalParams = { command: "pwd" };

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId,
        args: originalParams,
      } as never,
    );
    const result = await definition.execute(toolCallId, originalParams, undefined, undefined, {});
    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId,
        isError: false,
        result,
      } as never,
    );

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(toolCallId, mergedParams, undefined, undefined);
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId,
          params: mergedParams,
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
          toolCallId,
        }),
      );
    });
  });

  it("reports Pi dynamic tool execution errors through after_tool_call", async () => {
    const adjustedParams = { timeoutSec: 1 };
    const mergedParams = { command: "false", timeoutSec: 1 };
    const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
    const execute = vi.fn(async () => {
      throw new Error("tool failed");
    });
    const tool = wrapToolWithBeforeToolCallHook(createContractTool("exec", execute), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-error",
    });
    const definition = toToolDefinitions([tool])[0];
    if (!definition) {
      throw new Error("missing Pi tool definition");
    }
    const ctx = createToolHandlerCtx();
    ctx.params.runId = "run-error";
    const toolCallId = "call-error";
    const originalParams = { command: "false" };

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId,
        args: originalParams,
      } as never,
    );
    const result = await definition.execute(toolCallId, originalParams, undefined, undefined, {});
    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          status: "error",
          error: "tool failed",
        }),
      }),
    );
    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId,
        isError: true,
        result,
      } as never,
    );

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(toolCallId, mergedParams, undefined, undefined);
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId,
          params: mergedParams,
          error: "tool failed",
        }),
        expect.objectContaining({
          runId: "run-error",
          toolCallId,
        }),
      );
    });
  });

  it("fails closed when before_tool_call blocks a Pi dynamic tool", async () => {
    const hooks = installOpenClawOwnedToolHooks({ blockReason: "blocked by policy" });
    const execute = vi.fn(async () => textToolResult("should not run"));
    const tool = wrapToolWithBeforeToolCallHook(createContractTool("message", execute), {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
      runId: "run-blocked",
    });
    const definition = toToolDefinitions([tool])[0];
    if (!definition) {
      throw new Error("missing Pi tool definition");
    }
    const ctx = createToolHandlerCtx();
    ctx.params.runId = "run-blocked";
    const toolCallId = "call-blocked";
    const originalParams = {
      action: "send",
      text: "blocked",
      provider: "telegram",
      to: "chat-1",
    };

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "message",
        toolCallId,
        args: originalParams,
      } as never,
    );
    const result = await definition.execute(toolCallId, originalParams, undefined, undefined, {});
    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          status: "error",
          error: "blocked by policy",
        }),
      }),
    );
    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "message",
        toolCallId,
        isError: true,
        result,
      } as never,
    );

    expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "message",
          toolCallId,
          params: originalParams,
          error: "blocked by policy",
        }),
        expect.objectContaining({
          agentId: "agent-1",
          sessionId: "session-1",
          sessionKey: "agent:agent-1:session-1",
          runId: "run-blocked",
          toolCallId,
        }),
      );
    });
  });
});
