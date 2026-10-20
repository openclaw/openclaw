import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { installResultMiddleware, textToolResult } from "./dynamic-tools.test-support.js";
import { CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE } from "./protocol.js";

async function callOrderStatus({
  canDeliverSourceReply = true,
  namespace = CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
}: { canDeliverSourceReply?: boolean; namespace?: string | null } = {}) {
  const bridge = createCodexDynamicToolBridge({
    tools: [
      {
        name: "order_status",
        label: "order_status",
        description: "Order status fixture",
        parameters: Type.Object({}, { additionalProperties: true }),
        ...(canDeliverSourceReply ? { canDeliverSourceReply: true } : {}),
        execute: async () => textToolResult(JSON.stringify(replyDetails), replyDetails),
      },
    ],
    signal: new AbortController().signal,
  });
  const result = await bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace,
    tool: "order_status",
    arguments: {},
  });
  return { bridge, result };
}

const replyDetails = {
  ok: true,
  sourceReply: {
    text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
    mediaUrls: ["/tmp/a.pdf"],
  },
};

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Codex tool-authored source replies", () => {
  it("holds the reply candidate until batch settlement for a capable tool", async () => {
    const { bridge, result } = await callOrderStatus();

    expect(result.success).toBe(true);
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([]);
    expect(result.toolAuthoredSourceReply).toEqual({
      text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
      mediaUrls: ["/tmp/a.pdf"],
      idempotencyKey: "turn-1:tool-source-reply:call-1",
      sourceReplyFinal: true,
      toolAuthored: true,
      toolAuthoredForToolCallId: "call-1",
      toolAuthoredForTurnId: "turn-1",
    });
    // No message tool ran, so messaging delivery evidence stays untouched.
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
  });

  it("holds the candidate as rewritten by result middleware", async () => {
    installResultMiddleware((event) => ({
      result: {
        content: event.result.content,
        details: { sourceReply: { text: "Pedido SO1 creado." } },
      },
    }));
    const { bridge, result } = await callOrderStatus();

    expect(result.terminate).toBe(true);
    expect(result.toolAuthoredSourceReply).toMatchObject({ text: "Pedido SO1 creado." });
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([]);
  });

  it("delivers nothing when result middleware withdraws the reply", async () => {
    installResultMiddleware((event) => ({
      result: { content: event.result.content, details: { redacted: true } },
    }));
    const { bridge, result } = await callOrderStatus();

    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([]);
  });

  it("ignores sourceReply details from a tool without the capability", async () => {
    const { bridge, result } = await callOrderStatus({ canDeliverSourceReply: false });

    expect(result.success).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([]);
  });

  it("ignores a reply from the searchable namespace, which Code Mode programs can reach", async () => {
    const { bridge, result } = await callOrderStatus({ namespace: "openclaw" });

    expect(result.success).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(result.toolAuthoredSourceReply).toBeUndefined();
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([]);
  });
});
