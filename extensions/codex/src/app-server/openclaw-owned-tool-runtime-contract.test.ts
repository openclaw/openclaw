import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  installCodexToolResultMiddleware,
  installOpenClawOwnedToolHooks,
  resetOpenClawOwnedToolHooks,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { JsonObject } from "./protocol.js";

const callId = "call-contract";
const hookContext = {
  runId: "run-contract",
  agentId: "agent-1",
  sessionId: "session-1",
  sessionKey: "agent:agent-1:session-1",
};
afterEach(resetOpenClawOwnedToolHooks);

it.each(["middleware", "wrapped", "error", "message", "blocked"])(
  "preserves the native dynamic-tool contract (%s)",
  async (mode) => {
    const blocked = mode === "blocked";
    const failed = mode === "error";
    const messaging = mode === "message" || blocked;
    const toolName = messaging ? "message" : "exec";
    const target = {
      provider: "telegram",
      to: "chat-1",
      threadId: "thread-ts-1",
      text: "hello from Codex",
    };
    const mediaUrl = "/tmp/codex-reply.png";
    const args: JsonObject = messaging
      ? { ...target, action: "send", mediaUrl }
      : { command: failed ? "false" : "status" };
    const adjustedParams = messaging ? undefined : { mode: "safe" };
    const params = { ...args, ...adjustedParams };
    const hooks = installOpenClawOwnedToolHooks({
      adjustedParams,
      ...(blocked ? { blockReason: "blocked by policy" } : {}),
    });
    const raw = messaging
      ? textToolResult("Sent.", { messageId: "message-1" })
      : textToolResult("raw output", { stage: "execute" });
    const final = textToolResult("compacted output", { stage: "middleware" });
    const execute = vi.fn(async () => {
      if (failed) {
        throw new Error("tool failed");
      }
      return raw;
    });
    const tool = {
      name: toolName,
      description: "Run a tool.",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      execute,
    } as unknown as AnyAgentTool;
    const bridge = createCodexDynamicToolBridge({
      tools: [mode === "wrapped" ? wrapToolWithBeforeToolCallHook(tool, hookContext) : tool],
      signal: new AbortController().signal,
      hookContext,
    });
    if (!messaging && !failed) {
      installCodexToolResultMiddleware((event) => {
        expect(event.args).toEqual(params);
        expect(event.result).toEqual(raw);
        return final;
      });
    }
    const response = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId,
      namespace: null,
      tool: toolName,
      arguments: args,
    });
    expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
      success: !blocked && !failed,
      contentItems: [
        {
          type: "inputText",
          text: blocked
            ? "blocked by policy"
            : failed
              ? "tool failed"
              : messaging
                ? "Sent."
                : "compacted output",
        },
      ],
    });
    expect(hooks.beforeToolCall).toHaveBeenCalledOnce();
    if (blocked) {
      expect(execute).not.toHaveBeenCalled();
    } else {
      expect(execute).toHaveBeenCalledOnce();
    }
    const result = blocked
      ? textToolResult("blocked by policy", {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        })
      : messaging
        ? raw
        : final;
    await vi.waitFor(() =>
      expect(hooks.afterToolCall).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          toolName,
          toolCallId: callId,
          params,
          ...(failed ? { error: "tool failed" } : { result: expect.objectContaining(result) }),
        }),
        expect.objectContaining({ ...hookContext, toolCallId: callId }),
      ),
    );
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(mode === "message");
    if (mode === "message") {
      expect(bridge.telemetry).toMatchObject({
        messagingToolSentTexts: [target.text],
        messagingToolSentMediaUrls: [mediaUrl],
      });
      expect(bridge.telemetry.messagingToolSentTargets).toEqual([
        { tool: "message", ...target, mediaUrls: [mediaUrl] },
      ]);
    }
  },
);
