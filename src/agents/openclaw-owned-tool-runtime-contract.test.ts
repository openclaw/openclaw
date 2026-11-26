import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import {
  installOpenClawOwnedToolHooks,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { createToolHandlerMocks } from "./agent-tool-handler-state.test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import { prepareToolResult } from "./embedded-agent-tool-results.js";

afterEach(resetOpenClawOwnedToolHooks);
const session = {
  agentId: "agent-1",
  sessionId: "session-1",
  sessionKey: "agent:agent-1:session-1",
};

it.each(["success", "error", "message", "blocked"] as const)(
  "preserves the embedded tool contract on %s",
  async (outcome) => {
    const blocked = outcome === "blocked";
    const fails = outcome === "error";
    const messaging = outcome === "message" || blocked;
    const toolName = messaging ? "message" : "exec";
    const runId = "run-" + outcome;
    const toolCallId = "call-" + outcome;
    const args = messaging
      ? {
          action: "send",
          content: "hello",
          mediaUrl: "/tmp/reply.png",
          provider: "telegram",
          to: "chat-1",
        }
      : { command: fails ? "false" : "pwd" };
    const adjustedParams = messaging ? undefined : fails ? { timeoutSec: 1 } : { mode: "safe" };
    const hooks = installOpenClawOwnedToolHooks({
      adjustedParams,
      ...(blocked ? { blockReason: "blocked by policy" } : {}),
    });
    const expected = textToolResult(
      messaging ? "sent" : "done",
      messaging ? { deliveryStatus: "sent" } : { ok: true },
    );
    const execute = vi.fn(async () => {
      if (fails) {
        throw new Error("tool failed");
      }
      return structuredClone(expected);
    });
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: toolName,
        label: toolName,
        description: toolName,
        parameters: { type: "object", properties: {} },
        execute,
      } as AgentTool,
      { ...session, runId },
    );
    const definition = toToolDefinitions([tool])[0];
    expect(definition).toBeDefined();
    const ctx = { params: { ...session, runId }, ...createToolHandlerMocks() };
    const event = { toolName, toolCallId };
    await handleToolExecutionStart(ctx, {
      ...event,
      type: "tool_execution_start",
      args,
    } as Parameters<typeof handleToolExecutionStart>[1]);
    const result = await definition!.execute(
      toolCallId,
      args,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    await handleToolExecutionEnd(
      ctx,
      {
        ...event,
        type: "tool_execution_end",
        isError: fails || blocked,
        result,
      } as Parameters<typeof handleToolExecutionEnd>[1],
      prepareToolResult(result),
    );
    const params = { ...args, ...adjustedParams };
    if (blocked) {
      expect(execute).not.toHaveBeenCalled();
      expect(result).toEqual({
        content: [{ type: "text", text: "blocked by policy" }],
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      });
    } else {
      expect(execute).toHaveBeenCalledWith(toolCallId, params, undefined, undefined);
      if (fails) {
        expect(result).toMatchObject({ details: { status: "error", error: "tool failed" } });
      }
    }
    expect(hooks.beforeToolCall).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(hooks.afterToolCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ...event,
          params,
          ...(fails ? { error: "tool failed" } : { result: blocked ? result : expected }),
          ...(blocked ? { error: "blocked by policy" } : {}),
        }),
        expect.objectContaining({ runId, toolCallId, ...(fails ? {} : session) }),
      );
    });
    if (outcome === "message") {
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
    }
  },
);
