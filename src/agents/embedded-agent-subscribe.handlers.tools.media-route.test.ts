import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  createTestContext,
  endTool,
  type ToolExecutionEndEvent,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";

type ToolExecutionStartEvent = Omit<Extract<AgentEvent, { type: "tool_execution_start" }>, "type">;

async function executeTool(
  ctx: ReturnType<typeof createTestContext>["ctx"],
  event: ToolExecutionStartEvent & Omit<ToolExecutionEndEvent, "toolName" | "toolCallId">,
) {
  const { toolName, toolCallId, args, ...completion } = event;
  await handleToolExecutionStart(ctx, { type: "tool_execution_start", toolName, toolCallId, args });
  await endTool(ctx, { toolName, toolCallId, ...completion });
}

describe("message-tool media route evidence", () => {
  it.each([
    ["the exact source route", "account-1", "chat123", "thread-1", true],
    ["the same target in another account", "account-2", "chat123", "thread-1", false],
    ["the same target in another thread", "account-1", "chat123", "thread-2", false],
    ["another target", "account-1", "chat456", "thread-1", false],
  ] as const)(
    "records explicit message sends only for %s",
    async (label, accountId, target, threadId, expected) => {
      const { ctx } = createTestContext();
      Object.assign(ctx.params, {
        config: {},
        sourceReplyDeliveryMode: "message_tool_only",
        messageChannel: "test-channel",
        currentAccountId: "account-1",
        currentChannelId: "chat123",
        currentThreadId: "thread-1",
      });

      await executeTool(ctx, {
        toolName: "message",
        toolCallId: `tool-message-explicit-${label}`,
        args: {
          action: "send",
          channel: "test-channel",
          accountId,
          target,
          threadId,
          message: "explicit reply",
          media: "/tmp/current-route.png",
        },
        result: { details: { ok: true } },
      });

      expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(expected);
      expect(ctx.state.currentSourceMessagingToolSentMediaUrls).toEqual(
        expected ? ["/tmp/current-route.png"] : [],
      );
    },
  );

  it("does not record media from partial same-route sends as delivery evidence", async () => {
    const { ctx } = createTestContext();
    Object.assign(ctx.params, {
      config: {},
      sourceReplyDeliveryMode: "message_tool_only",
      messageChannel: "test-channel",
      currentAccountId: "account-1",
      currentChannelId: "chat123",
      currentThreadId: "thread-1",
    });
    ctx.consumeToolSendReceipt = () => ({
      details: {
        messageDelivery: { status: "settled", partialDelivery: true, createdThreadIds: [] },
      },
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "partial-media-send",
      args: {
        action: "send",
        channel: "test-channel",
        accountId: "account-1",
        target: "chat123",
        threadId: "thread-1",
        message: "Text sent before attachment failure",
        media: "/tmp/current-route.png",
      },
      result: { details: { ok: true } },
    });

    expect(ctx.state.messagingToolSentMediaUrls).toEqual(["/tmp/current-route.png"]);
    expect(ctx.state.messagingToolSentTargets).toContainEqual(
      expect.objectContaining({ to: "chat123", mediaUrls: ["/tmp/current-route.png"] }),
    );
    expect(ctx.state.currentSourceMessagingToolSentMediaUrls).toEqual([]);
  });
});
