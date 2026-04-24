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

  it("preserves adjusted before_tool_call params through execution and after_tool_call", async () => {
    const adjustedParams = { command: "pwd", mode: "safe" };
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
    expect(execute).toHaveBeenCalledWith(toolCallId, adjustedParams, undefined, undefined);
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId,
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
          toolCallId,
        }),
      );
    });
  });
});
