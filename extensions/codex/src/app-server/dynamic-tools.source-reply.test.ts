import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type {
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
  JsonObject,
  JsonValue,
} from "./protocol.js";

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

function createDynamicToolCall(
  tool: string,
  arguments_: JsonValue = {},
  callId = "call-1",
): CodexDynamicToolCallParams {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId,
    namespace: null,
    tool,
    arguments: arguments_,
  };
}

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function createSingleToolBridge(
  tool: AnyAgentTool,
  options: Omit<Parameters<typeof createCodexDynamicToolBridge>[0], "tools" | "signal"> = {},
) {
  return createCodexDynamicToolBridge({
    tools: [tool],
    signal: new AbortController().signal,
    ...options,
  });
}

function createBridgeWithToolResult(
  toolName: string,
  toolResult: AgentToolResult<unknown>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  return createSingleToolBridge(
    createTool({ name: toolName, execute: vi.fn(async () => toolResult) }),
    { hookContext },
  );
}

function expectInputText(response: CodexDynamicToolCallResponse, text: string, success = true) {
  expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
    success,
    contentItems: [{ type: "inputText", text }],
  });
}

async function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  arguments_: JsonValue,
) {
  return await bridge.handleToolCall(createDynamicToolCall("message", arguments_));
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Codex dynamic-tool source replies", () => {
  it.each(["automatic", "message_tool_only", undefined] as const)(
    "preserves confirmed source delivery when middleware redacts details in %s mode",
    async (sourceReplyDeliveryMode) => {
      installResultMiddleware((event) => ({
        result: { content: event.result.content, details: { redacted: true } },
      }));
      const bridge = createBridgeWithToolResult(
        "message",
        textToolResult("Sent.", {
          messageDelivery: {
            status: "settled",
            primaryPlatformMessageId: "imessage-6264",
            partialDelivery: false,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
          receipt: {
            primaryPlatformMessageId: "imessage-6264",
            platformMessageIds: ["imessage-6264"],
          },
        }),
        { sourceReplyDeliveryMode },
      );

      const result = await handleMessageToolCall(bridge, {
        action: "send",
        message: "visible reply",
        final: true,
      });

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
      const bridge = createBridgeWithToolResult(
        "message",
        textToolResult("Sent.", {
          messageDelivery: {
            status: "settled",
            partialDelivery: false,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
        }),
        { sourceReplyDeliveryMode: "automatic" },
      );

      const result = await handleMessageToolCall(bridge, {
        action: "send",
        message: "visible reply",
        final: true,
      });

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
      const bridge = createBridgeWithToolResult(
        "message",
        { ...textToolResult("Sent.", { ok: true }), terminate: true },
        {
          sourceReplyDeliveryMode,
        },
      );

      const result = await handleMessageToolCall(bridge, {
        action: "reply",
        channel: "imessage",
        target: "+12069106512",
        messageId: "868",
        message: "Still working.",
        buttons: [],
        final: false,
      });

      expectInputText(result, "Sent.");
      expect(result.terminate).toBeUndefined();
      expect(bridge.telemetry.messagingToolSentTargets.at(-1)).toMatchObject({
        sourceReplyFinal: false,
      });
    },
  );

  it("ends automatic mode after a confirmed final source reaction", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Reacted.", {
        ok: true,
        messageDelivery: {
          status: "settled",
          partialDelivery: false,
          createdThreadIds: [],
          sourceReplyDelivered: true,
        },
      }),
      { sourceReplyDeliveryMode: "automatic" },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "react",
      emoji: "👍",
      final: true,
    });

    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.sourceReplyDelivered).toBe(true);
  });

  it.each<JsonObject>([
    { action: "react", remove: true, final: true },
    { action: "react", final: true },
    { action: "send", to: "other-chat", final: true },
    { action: "send", dryRun: true, final: true },
  ])("continues automatic mode without confirmed source delivery (%j)", async (args) => {
    const bridge = createBridgeWithToolResult("message", textToolResult("Done.", { ok: true }), {
      sourceReplyDeliveryMode: "automatic",
    });

    const result = await handleMessageToolCall(bridge, args);

    expect(result.terminate).toBeUndefined();
  });

  it("does not let prior message-send telemetry terminate a later non-delivery tool result", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(textToolResult("Sent.", { messageId: "source-reply-1" }))
      .mockResolvedValueOnce(textToolResult("No message sent.", { ok: true }));
    const bridge = createSingleToolBridge(createTool({ name: "message", execute }), {
      hookContext: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const firstResult = await handleMessageToolCall(bridge, {
      action: "send",
      message: "visible reply",
    });
    const secondResult = await bridge.handleToolCall(
      createDynamicToolCall("message", { action: "inspect" }, "call-2"),
    );

    expect(firstResult.terminate).toBe(true);
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expectInputText(secondResult, "No message sent.");
    expect(secondResult.terminate).toBeUndefined();
  });
});
