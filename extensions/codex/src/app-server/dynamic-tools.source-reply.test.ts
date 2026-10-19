import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolCallResponse, JsonObject, JsonValue } from "./protocol.js";

function installResultMiddleware(
  handler: ReturnType<
    typeof createEmptyPluginRegistry
  >["agentToolResultMiddlewares"][number]["handler"],
) {
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "test-result",
    pluginName: "Test result",
    rawHandler: handler,
    handler,
    runtimes: ["codex"],
    source: "test",
  });
  setActivePluginRegistry(registry);
}

function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function bridgeForResult(
  result: AgentToolResult<unknown> | AnyAgentTool["execute"],
  hookContext: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"] = {
    sourceReplyDeliveryMode: "automatic",
  },
) {
  return createCodexDynamicToolBridge({
    tools: [
      {
        name: "message",
        label: "Message",
        description: "Send a message.",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: typeof result === "function" ? result : vi.fn(async () => result),
      },
    ],
    signal: new AbortController().signal,
    hookContext,
  });
}

function deliveredResult(text = "Sent.", details = {}, delivery = {}) {
  return textToolResult(text, {
    ...details,
    messageDelivery: {
      status: "settled",
      partialDelivery: false,
      createdThreadIds: [],
      sourceReplyDelivered: true,
      ...delivery,
    },
  });
}

function expectInputText(response: CodexDynamicToolCallResponse, text: string) {
  expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
    success: true,
    contentItems: [{ type: "inputText", text }],
  });
}

async function callMessage(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  arguments_: JsonValue,
  callId = "call-1",
) {
  return bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId,
    namespace: null,
    tool: "message",
    arguments: arguments_,
  });
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

const finalSend = { action: "send", message: "visible reply", final: true };
it.each(["automatic", "message_tool_only", undefined] as const)(
  "preserves confirmed source delivery when middleware redacts details in %s mode",
  async (sourceReplyDeliveryMode) => {
    installResultMiddleware((event) => ({
      result: { content: event.result.content, details: { redacted: true } },
    }));
    const id = "imessage-6264";
    const bridge = bridgeForResult(
      deliveredResult(
        "Sent.",
        { receipt: { primaryPlatformMessageId: id, platformMessageIds: [id] } },
        { primaryPlatformMessageId: id },
      ),
      { sourceReplyDeliveryMode },
    );

    const result = await callMessage(bridge, finalSend);

    expectInputText(result, "Sent.");
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.sourceReplyDelivered).toBe(true);
    expect(Object.keys(toCodexDynamicToolProtocolResponse(result))).not.toContain("terminate");
  },
);

it.each(["error", "throw"] as const)(
  "preserves committed final source delivery when middleware returns %s",
  async (presentation) => {
    installResultMiddleware(() => {
      if (presentation === "throw") {
        throw new Error("presentation failed");
      }
      return { result: textToolResult("presentation failed", { error: "presentation failed" }) };
    });
    const bridge = bridgeForResult(deliveredResult());

    const result = await callMessage(bridge, finalSend);

    expect(result).toMatchObject({
      success: presentation === "throw",
      terminate: true,
      finalSourceReplyDelivered: true,
      diagnosticTerminalType: presentation === "throw" ? "completed" : "error",
    });
    expect(bridge.telemetry.finalSourceReplyDelivered).toBe(true);
    if (presentation === "throw") {
      expect(result.transcriptDetails).toMatchObject({
        middlewareWarning: "post-processing failed",
      });
    }
  },
);

it.each(["automatic", "message_tool_only", undefined] as const)(
  "honors explicit progress message-tool finality in %s mode",
  async (sourceReplyDeliveryMode) => {
    const bridge = bridgeForResult(
      { ...textToolResult("Sent.", { ok: true }), terminate: true },
      { sourceReplyDeliveryMode },
    );

    const result = await callMessage(bridge, {
      action: "reply",
      channel: "imessage",
      target: "+12069106512",
      message: "Still working.",
      final: false,
    });

    expectInputText(result, "Sent.");
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.messagingToolSentTargets.at(-1)).toMatchObject({
      sourceReplyFinal: false,
    });
  },
);

const deliveryTarget = "-1001234567890";
it.each([
  { finalByDefault: false, final: undefined, ends: false },
  { finalByDefault: false, final: false, ends: false },
  { finalByDefault: false, final: true, ends: true },
  { finalByDefault: undefined, final: undefined, ends: true },
])(
  "ends the turn only when final resolves true (default $finalByDefault, final $final)",
  async ({ finalByDefault, final, ends }) => {
    const bridge = bridgeForResult(
      deliveredResult(
        '{"ok":true,"messageId":"4242"}',
        { ok: true, messageId: "4242", chatId: deliveryTarget },
        { primaryPlatformMessageId: "4242", deliveredTargets: [deliveryTarget] },
      ),
      {
        currentChannelProvider: "telegram",
        currentChannelId: deliveryTarget,
        ...(finalByDefault === undefined ? {} : { messageToolFinalByDefault: finalByDefault }),
      },
    );

    const result = await callMessage(bridge, {
      action: "send",
      channel: "telegram",
      target: deliveryTarget,
      message: "daily drop",
      ...(final === undefined ? {} : { final }),
    });

    expect(result.terminate).toBe(ends ? true : undefined);
    expect(result.finalSourceReplyDelivered).toBe(ends ? true : undefined);
    expect(bridge.telemetry.finalSourceReplyDelivered).toBe(ends ? true : undefined);
    expect(bridge.telemetry.sourceReplyDelivered).toBe(true);
    expect(bridge.telemetry.messagingToolSentTargets.at(-1)).toMatchObject({
      to: deliveryTarget,
      sourceReplyFinal: ends,
    });
  },
);

it("ends automatic mode after a confirmed final source reaction", async () => {
  const bridge = bridgeForResult(deliveredResult("Reacted.", { ok: true }));

  const result = await callMessage(bridge, { action: "react", emoji: "👍", final: true });

  expect(result.terminate).toBe(true);
  expect(bridge.telemetry.sourceReplyDelivered).toBe(true);
});

it.each<JsonObject>([
  { action: "react", remove: true, final: true },
  { action: "react", final: true },
  { action: "send", to: "other-chat", final: true },
  { action: "send", dryRun: true, final: true },
])("continues automatic mode without confirmed source delivery (%j)", async (args) => {
  const bridge = bridgeForResult(textToolResult("Done.", { ok: true }));

  const result = await callMessage(bridge, args);

  expect(result.terminate).toBeUndefined();
});

it("does not let prior message-send telemetry terminate a later non-delivery tool result", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(textToolResult("Sent.", { messageId: "source-reply-1" }))
    .mockResolvedValueOnce(textToolResult("No message sent.", { ok: true }));
  const bridge = bridgeForResult(execute, { sourceReplyDeliveryMode: "message_tool_only" });

  const firstResult = await callMessage(bridge, { action: "send", message: "visible reply" });
  const secondResult = await callMessage(bridge, { action: "inspect" }, "call-2");

  expect(firstResult.terminate).toBe(true);
  expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
  expectInputText(secondResult, "No message sent.");
  expect(secondResult.terminate).toBeUndefined();
});
