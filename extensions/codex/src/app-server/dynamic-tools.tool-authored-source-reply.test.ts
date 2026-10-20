import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
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
  expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([]);
  expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
  return result;
}

const replyDetails = {
  ok: true,
  sourceReply: {
    text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
    mediaUrls: ["/tmp/a.pdf"],
  },
};

afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

function replaceDetails(details: Record<string, unknown>) {
  installResultMiddleware((event) => ({
    result: { content: event.result.content, details },
  }));
}

it("holds the reply candidate until batch settlement for a capable tool", async () => {
  const result = await callOrderStatus();

  expect(result).toMatchObject({ success: true, terminate: true });
  expect(result.toolAuthoredSourceReply).toEqual({
    text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
    mediaUrls: ["/tmp/a.pdf"],
    idempotencyKey: "turn-1:tool-source-reply:call-1",
    sourceReplyFinal: true,
    toolAuthored: true,
    toolAuthoredForToolCallId: "call-1",
    toolAuthoredForTurnId: "turn-1",
  });
});

it("holds the candidate as rewritten by result middleware", async () => {
  replaceDetails({ sourceReply: { text: "Pedido SO1 creado." } });
  const result = await callOrderStatus();

  expect(result.terminate).toBe(true);
  expect(result.toolAuthoredSourceReply).toMatchObject({ text: "Pedido SO1 creado." });
});

it("delivers nothing when result middleware withdraws the reply", async () => {
  replaceDetails({ redacted: true });
  const result = await callOrderStatus();

  expect(result.terminate).toBeUndefined();
});

it.each([
  [false, CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE],
  [true, "openclaw"],
] as const)(
  "rejects sourceReply (capable: %s, namespace: %s)",
  async (canDeliverSourceReply, namespace) => {
    const result = await callOrderStatus({ canDeliverSourceReply, namespace });
    expect(result.success).toBe(true);
    expect(result.terminate).toBeUndefined();
    if (namespace === "openclaw") {
      expect(result.toolAuthoredSourceReply).toBeUndefined();
    }
  },
);
