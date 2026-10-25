import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import {
  installOpenClawOwnedToolHooks,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { createToolHandlerMocks } from "./agent-tool-handler-state.test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import { prepareToolResult } from "./embedded-agent-tool-results.js";

type ToolExecutionStartEvent = Parameters<typeof handleToolExecutionStart>[1];
type ToolExecutionEndEvent = Parameters<typeof handleToolExecutionEnd>[1];

const session = {
  agentId: "agent-1",
  sessionId: "session-1",
  sessionKey: "agent:agent-1:session-1",
};
const messageTarget = { action: "send", provider: "telegram", to: "chat-1" };

async function startContract(
  toolName: string,
  execute: AgentTool["execute"],
  args: Record<string, unknown>,
  suffix: string,
) {
  const runId = `run-${suffix}`;
  const toolCallId = `call-${suffix}`;
  const tool = wrapToolWithBeforeToolCallHook(
    {
      name: toolName,
      label: toolName,
      description: `contract tool: ${toolName}`,
      parameters: { type: "object", properties: {} },
      execute,
    } as AgentTool,
    {
      ...session,
      runId,
    },
  );
  const definition = toToolDefinitions([tool])[0];
  if (!definition) {
    throw new Error("missing embedded agent tool definition");
  }
  const ctx = { params: { ...session, runId }, ...createToolHandlerMocks() };
  const event = { toolName, toolCallId };
  await handleToolExecutionStart(ctx, {
    ...event,
    type: "tool_execution_start",
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
    expectAfter: (
      hooks: ReturnType<typeof installOpenClawOwnedToolHooks>,
      payload: Record<string, unknown>,
      context: Record<string, unknown> = {},
    ) => {
      expect(hooks.beforeToolCall).toHaveBeenCalledTimes(1);
      // after_tool_call fires asynchronously after the execution-end event.
      return vi.waitFor(() => {
        expect(hooks.afterToolCall).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ toolName, toolCallId, ...payload }),
          expect.objectContaining({ runId, toolCallId, ...context }),
        );
      });
    },
    finish: (isError = false) =>
      handleToolExecutionEnd(
        ctx,
        {
          type: "tool_execution_end",
          ...event,
          isError,
          result,
        } as ToolExecutionEndEvent,
        prepareToolResult(result),
      ),
  };
}

describe("OpenClaw-owned tool runtime contract - embedded agent adapter", () => {
  afterEach(resetOpenClawOwnedToolHooks);

  it.each([
    { outcome: "success", command: "pwd", adjustedParams: { mode: "safe" }, fails: false },
    { outcome: "error", command: "false", adjustedParams: { timeoutSec: 1 }, fails: true },
  ])(
    "preserves adjusted params through execution and after_tool_call on $outcome",
    async ({ command, adjustedParams, fails }) => {
      const params = { command, ...adjustedParams };
      const hooks = installOpenClawOwnedToolHooks({ adjustedParams });
      const expected = { content: [{ type: "text", text: "done" }], details: { ok: true } };
      const execute = vi.fn(async () => {
        if (fails) {
          throw new Error("tool failed");
        }
        return textToolResult("done", { ok: true });
      });
      const { result, toolCallId, finish, expectAfter } = await startContract(
        "exec",
        execute,
        { command },
        fails ? "error" : "contract",
      );
      if (fails) {
        expect(result).toMatchObject({ details: { status: "error", error: "tool failed" } });
      }
      await finish(fails);
      expect(execute).toHaveBeenCalledWith(toolCallId, params, undefined, undefined);
      await expectAfter(
        hooks,
        { params, ...(fails ? { error: "tool failed" } : { result: expected }) },
        fails ? {} : session,
      );
    },
  );

  it("commits successful embedded agent messaging text, media, and target telemetry", async () => {
    const hooks = installOpenClawOwnedToolHooks();
    const execute = vi.fn(async () => textToolResult("sent", { deliveryStatus: "sent" }));
    const originalParams = { ...messageTarget, content: "hello", mediaUrl: "/tmp/reply.png" };

    const { ctx, finish, expectAfter } = await startContract(
      "message",
      execute,
      originalParams,
      "message",
    );
    await finish();

    expect(ctx.state).toMatchObject({
      messagingToolSentTexts: ["hello"],
      messagingToolSentMediaUrls: ["/tmp/reply.png"],
      messagingToolSentTargets: [
        expect.objectContaining({
          tool: "message",
          provider: "telegram",
          to: "chat-1",
          text: "hello",
          mediaUrls: ["/tmp/reply.png"],
        }),
      ],
    });
    await expectAfter(hooks, {
      params: originalParams,
      result: expect.objectContaining({ content: [{ type: "text", text: "sent" }] }),
    });
  });

  it("fails closed when before_tool_call blocks an embedded agent dynamic tool", async () => {
    const hooks = installOpenClawOwnedToolHooks({ blockReason: "blocked by policy" });
    const execute = vi.fn(async () => textToolResult("should not run"));
    const originalParams = { ...messageTarget, text: "blocked" };

    const { result, finish, expectAfter } = await startContract(
      "message",
      execute,
      originalParams,
      "blocked",
    );
    const blocked = {
      status: "blocked",
      deniedReason: "plugin-before-tool-call",
      reason: "blocked by policy",
    };
    expect(result).toMatchObject({ details: blocked });
    await finish(true);

    expect(execute).not.toHaveBeenCalled();
    await expectAfter(
      hooks,
      {
        params: originalParams,
        result: {
          content: [{ type: "text", text: "blocked by policy" }],
          details: blocked,
        },
        error: "blocked by policy",
      },
      session,
    );
  });
});
