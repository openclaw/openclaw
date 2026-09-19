import { textToolResult } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { JsonValue } from "./protocol.js";

function createBridgeWithToolResult(
  toolName: string,
  result: ReturnType<typeof textToolResult>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  return createCodexDynamicToolBridge({
    tools: [
      {
        name: toolName,
        label: toolName,
        description: "Message delivery fixture",
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async () => result,
      },
    ],
    signal: new AbortController().signal,
    hookContext,
  });
}

function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  args: JsonValue,
) {
  return bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: "message",
    arguments: args,
  });
}

describe("Codex message delivery facts", () => {
  it.each([0, 9_000])(
    "preserves delivery from a JSON receipt with %i extra characters",
    async (paddingLength) => {
      const bridge = createBridgeWithToolResult(
        "message",
        textToolResult(
          JSON.stringify({
            ok: true,
            messageId: "legacy-receipt-1",
            note: "x".repeat(paddingLength),
          }),
        ),
        { sourceReplyDeliveryMode: "message_tool_only" },
      );

      const result = await handleMessageToolCall(bridge, {
        action: "send",
        message: "delivered reply",
        mediaUrl: "/tmp/reply.png",
      });

      expect(result.success).toBe(true);
      expect(result.terminate).toBe(true);
      expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
      expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual(["/tmp/reply.png"]);
    },
  );

  it.each(["dryRun", "suppressed", "failed"] as const)(
    "does not record %s message sends as delivered",
    async (status) => {
      const bridge = createBridgeWithToolResult(
        "message",
        textToolResult("No message delivered.", {
          messageDelivery: { status, partialDelivery: false, createdThreadIds: [] },
        }),
      );

      const result = await handleMessageToolCall(bridge, {
        action: "send",
        channel: "slack",
        target: "channel:C123",
        message: "Final answer must remain deliverable.",
      });

      expect(result.success).toBe(true);
      expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
      expect(bridge.telemetry.messagingToolSentTexts).toEqual([]);
      expect(bridge.telemetry.messagingToolSentTargets).toEqual([]);
    },
  );

  it.each([0, 9_000])(
    "does not infer delivery from a failed JSON receipt with %i extra characters",
    async (paddingLength) => {
      const bridge = createBridgeWithToolResult(
        "message",
        textToolResult(
          JSON.stringify({
            ok: false,
            error: "send failed",
            messageId: "attempt-id",
            note: "x".repeat(paddingLength),
          }),
        ),
        { sourceReplyDeliveryMode: "message_tool_only" },
      );

      const result = await handleMessageToolCall(bridge, {
        action: "send",
        message: "Reply still needs delivery.",
        mediaUrl: "/tmp/reply.png",
      });

      expect(result.terminate).toBeUndefined();
      expect(bridge.telemetry.didSendViaMessagingTool).toBe(false);
      expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
      expect(bridge.telemetry.messagingToolSentTexts).toEqual([]);
      expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual([]);
    },
  );

  it("retains explicit partial JSON delivery without confirming all requested media", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult(
        JSON.stringify({
          ok: false,
          error: "second attachment failed",
          messageId: "partial-receipt-1",
          sentBeforeError: true,
        }),
      ),
      { sourceReplyDeliveryMode: "message_tool_only" },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      message: "Partially delivered reply.",
      mediaUrls: ["/tmp/first.png", "/tmp/second.png"],
    });

    expect(result.terminate).toBe(true);
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual([]);
  });

  it.each(["settled", "failed"] as const)(
    "uses a canonical %s delivery fact over contradictory JSON text",
    async (status) => {
      const delivered = status === "settled";
      const bridge = createBridgeWithToolResult(
        "message",
        textToolResult(
          JSON.stringify({
            ok: !delivered,
            ...(delivered ? { error: "stale failure" } : {}),
            messageId: "legacy-receipt-1",
          }),
          { messageDelivery: { status, partialDelivery: false, createdThreadIds: [] } },
        ),
        { sourceReplyDeliveryMode: "message_tool_only" },
      );

      const result = await handleMessageToolCall(bridge, {
        action: "send",
        message: "Canonical delivery reply.",
        mediaUrl: "/tmp/reply.png",
      });

      expect(result.terminate).toBe(delivered ? true : undefined);
      expect(bridge.telemetry.didSendViaMessagingTool).toBe(delivered);
      expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(delivered);
      expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual(
        delivered ? ["/tmp/reply.png"] : [],
      );
    },
  );

  it("preserves source reply attachment and transcript ownership facts", async () => {
    const attachment = {
      url: "https://example.test/reply.png",
      mimeType: "image/png",
      name: "reply.png",
      width: 640,
      height: 480,
      trustedLocalMedia: false,
    };
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent to current chat.", {
        deliveryStatus: "sent",
        messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
        sourceReplySink: "internal-ui",
        sourceReplyTranscriptOwner: true,
        idempotencyKey: "reply-owner-1",
        sourceReply: {
          text: "visible reply",
          attachments: [attachment],
          trustedLocalMedia: false,
        },
      }),
    );

    await handleMessageToolCall(bridge, { action: "send", message: "visible reply" });

    expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "visible reply",
        attachments: [attachment],
        trustedLocalMedia: false,
        transcriptOwner: true,
        idempotencyKey: "reply-owner-1",
      },
    ]);
  });

  it("does not terminate a source reply after delivery from another account", async () => {
    const bridge = createBridgeWithToolResult(
      "message",
      textToolResult("Sent.", {
        messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
      }),
      {
        sessionKey: "agent:main:slack:channel:C123",
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
        currentMessagingTarget: "channel:C123",
        turnSourceAccountId: "source-account",
      },
    );

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      channel: "slack",
      accountId: "another-account",
      target: "channel:C123",
      message: "Cross-account message.",
    });

    expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(bridge.telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });
});
