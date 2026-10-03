// A `canDeliverSourceReply` dynamic tool ends the Codex turn with its own reply;
// ordinary tools returning the same details stay on the normal model path.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

function createBridge(params: {
  canDeliverSourceReply?: boolean;
  details: Record<string, unknown>;
}) {
  return createCodexDynamicToolBridge({
    tools: [
      {
        name: "order_status",
        label: "order_status",
        description: "Order status fixture",
        parameters: Type.Object({}, { additionalProperties: true }),
        ...(params.canDeliverSourceReply ? { canDeliverSourceReply: true } : {}),
        execute: async () => ({
          content: [{ type: "text" as const, text: JSON.stringify(params.details) }],
          details: params.details,
        }),
      },
    ],
    signal: new AbortController().signal,
  });
}

function callOrderStatus(bridge: ReturnType<typeof createCodexDynamicToolBridge>) {
  return bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: "order_status",
    arguments: {},
  });
}

const replyDetails = {
  ok: true,
  sourceReply: {
    text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
    mediaUrls: ["/tmp/a.pdf"],
  },
};

describe("Codex tool-authored source replies", () => {
  it("records the reply payload and terminates the turn for a capable tool", async () => {
    const bridge = createBridge({ canDeliverSourceReply: true, details: replyDetails });

    const result = await callOrderStatus(bridge);

    expect(result.success).toBe(true);
    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
        mediaUrls: ["/tmp/a.pdf"],
        toolAuthored: true,
        idempotencyKey: "turn-1:tool-source-reply:call-1",
        sourceReplyFinal: true,
      },
    ]);
    // No message tool ran, so messaging delivery evidence stays untouched.
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
  });

  it("keeps the turn running for a progress reply", async () => {
    const bridge = createBridge({
      canDeliverSourceReply: true,
      details: { sourceReply: { text: "Comprobando stock…", final: false } },
    });

    const result = await callOrderStatus(bridge);

    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([
      expect.objectContaining({ text: "Comprobando stock…", sourceReplyFinal: false }),
    ]);
  });

  it("ignores sourceReply details from a tool without the capability", async () => {
    const bridge = createBridge({ details: replyDetails });

    const result = await callOrderStatus(bridge);

    expect(result.success).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([]);
  });
});
