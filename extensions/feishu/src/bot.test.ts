import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { parseFeishuMessageEvent } from "./bot.js";

// --- Helpers ---

function makeEvent(overrides?: Partial<FeishuMessageEvent>): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_test_sender",
        user_id: "user_test",
      },
      sender_type: "user",
    },
    message: {
      message_id: "om_test_msg_001",
      chat_id: "oc_test_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "Hello world" }),
      ...overrides?.message,
    },
    ...overrides,
  } as FeishuMessageEvent;
}

// --- Tests ---

describe("parseFeishuMessageEvent", () => {
  it("parses a simple text message", () => {
    const event = makeEvent();
    const ctx = parseFeishuMessageEvent(event);

    expect(ctx.chatId).toBe("oc_test_group");
    expect(ctx.messageId).toBe("om_test_msg_001");
    expect(ctx.senderId).toBe("user_test");
    expect(ctx.senderOpenId).toBe("ou_test_sender");
    expect(ctx.chatType).toBe("group");
    expect(ctx.content).toBe("Hello world");
    expect(ctx.mentionedBot).toBe(false);
  });

  it("parses a DM text message", () => {
    const event = makeEvent({
      message: {
        message_id: "om_dm_001",
        chat_id: "oc_dm_chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "DM message" }),
      },
    });
    const ctx = parseFeishuMessageEvent(event);

    expect(ctx.chatType).toBe("p2p");
    expect(ctx.content).toBe("DM message");
  });

  it("detects bot mention", () => {
    const botOpenId = "ou_bot_123";
    const event = makeEvent({
      message: {
        message_id: "om_mention_001",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@Bot hello" }),
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: botOpenId },
            name: "Bot",
            tenant_key: "t1",
          },
        ],
      },
    });

    const ctx = parseFeishuMessageEvent(event, botOpenId);
    expect(ctx.mentionedBot).toBe(true);
  });

  it("strips bot mention from content", () => {
    const botOpenId = "ou_bot_123";
    const event = makeEvent({
      message: {
        message_id: "om_strip_001",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@Bot please help me" }),
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: botOpenId },
            name: "Bot",
            tenant_key: "t1",
          },
        ],
      },
    });

    const ctx = parseFeishuMessageEvent(event, botOpenId);
    expect(ctx.content).not.toContain("@Bot");
    expect(ctx.content).toContain("help me");
  });

  it("preserves rootId and parentId", () => {
    const event = makeEvent({
      message: {
        message_id: "om_reply_001",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "reply" }),
        root_id: "om_root_001",
        parent_id: "om_parent_001",
      },
    });

    const ctx = parseFeishuMessageEvent(event);
    expect(ctx.rootId).toBe("om_root_001");
    expect(ctx.parentId).toBe("om_parent_001");
  });

  it("handles missing user_id gracefully", () => {
    const event = makeEvent();
    event.sender.sender_id.user_id = undefined;
    const ctx = parseFeishuMessageEvent(event);
    // Falls back to open_id
    expect(ctx.senderId).toBe("ou_test_sender");
  });

  it("handles post (rich text) message type", () => {
    const postContent = JSON.stringify({
      title: "Test Post",
      content: [[{ tag: "text", text: "Hello from post" }]],
    });

    const event = makeEvent({
      message: {
        message_id: "om_post_001",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "post",
        content: postContent,
      },
    });

    const ctx = parseFeishuMessageEvent(event);
    expect(ctx.content).toContain("Test Post");
    expect(ctx.content).toContain("Hello from post");
  });

  it("handles invalid JSON content gracefully", () => {
    const event = makeEvent({
      message: {
        message_id: "om_bad_001",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        content: "not valid json",
      },
    });

    const ctx = parseFeishuMessageEvent(event);
    // Should not throw, returns raw content
    expect(ctx.content).toBe("not valid json");
  });
});
