import { describe, it, expect } from "vitest";
import { checkBotMentioned } from "./bot-content.js";
import { parseFeishuMessageEvent } from "./bot.js";

// Helper to build a minimal FeishuMessageEvent for testing
function makeEvent(
  chatType: "p2p" | "group" | "private",
  mentions?: Array<{ key: string; name: string; id: { open_id?: string } }>,
  text = "hello",
) {
  return {
    sender: {
      sender_id: { user_id: "u1", open_id: "ou_sender" },
    },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions,
    },
  };
}

function makePostEvent(content: unknown) {
  return {
    sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: "group",
      message_type: "post",
      content: JSON.stringify(content),
      mentions: [],
    },
  };
}

function makeShareChatEvent(content: unknown) {
  return {
    sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: "group",
      message_type: "share_chat",
      content: JSON.stringify(content),
      mentions: [],
    },
  };
}

describe("parseFeishuMessageEvent – mentionedBot", () => {
  const BOT_OPEN_ID = "ou_bot_123";

  it("returns mentionedBot=false when there are no mentions", () => {
    const event = makeEvent("group", []);
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(false);
  });

  it("falls back to sender user_id when open_id is missing", () => {
    const event = makeEvent("p2p", []);
    (event as any).sender.sender_id = { user_id: "u_mobile_only" };

    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.senderOpenId).toBe("u_mobile_only");
    expect(ctx.senderId).toBe("u_mobile_only");
  });

  it("returns mentionedBot=true when bot is mentioned", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=true when bot mention name differs from configured botName", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "OpenClaw Bot (Alias)", id: { open_id: BOT_OPEN_ID } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, "OpenClaw Bot");
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=false when only other users are mentioned", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(false);
  });

  it("returns mentionedBot=false when botOpenId is undefined (unknown bot)", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, undefined);
    expect(ctx.mentionedBot).toBe(false);
  });

  it("returns mentionedBot=false when botOpenId is empty string (probe failed)", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } },
    ]);
    const ctx = parseFeishuMessageEvent(event as any, "");
    expect(ctx.mentionedBot).toBe(false);
  });

  it("treats mention.name regex metacharacters as literals when stripping", () => {
    const event = makeEvent(
      "group",
      [{ key: "@_bot_1", name: ".*", id: { open_id: BOT_OPEN_ID } }],
      "@NotBot hello",
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.content).toBe("@NotBot hello");
  });

  it("treats mention.key regex metacharacters as literals when stripping", () => {
    const event = makeEvent(
      "group",
      [{ key: ".*", name: "Bot", id: { open_id: BOT_OPEN_ID } }],
      "hello world",
    );
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.content).toBe("hello world");
  });

  it("returns mentionedBot=true for post message with at (no top-level mentions)", () => {
    const BOT_OPEN_ID = "ou_bot_123";
    const event = makePostEvent({
      content: [
        [{ tag: "at", user_id: BOT_OPEN_ID, user_name: "claw" }],
        [{ tag: "text", text: "What does this document say" }],
      ],
    });
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=false for post message with no at", () => {
    const event = makePostEvent({
      content: [[{ tag: "text", text: "hello" }]],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.mentionedBot).toBe(false);
  });

  it("returns mentionedBot=false for post message with at for another user", () => {
    const event = makePostEvent({
      content: [
        [{ tag: "at", user_id: "ou_other", user_name: "other" }],
        [{ tag: "text", text: "hello" }],
      ],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.mentionedBot).toBe(false);
  });

  it("preserves post code and code_block content", () => {
    const event = makePostEvent({
      content: [
        [
          { tag: "text", text: "before " },
          { tag: "code", text: "inline()" },
        ],
        [{ tag: "code_block", language: "ts", text: "const x = 1;" }],
      ],
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.content).toContain("before `inline()`");
    expect(ctx.content).toContain("```ts\nconst x = 1;\n```");
  });

  it("uses share_chat body when available", () => {
    const event = makeShareChatEvent({
      body: "Merged and Forwarded Message",
      share_chat_id: "sc_abc123",
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.content).toBe("Merged and Forwarded Message");
  });

  it("falls back to share_chat identifier when body is unavailable", () => {
    const event = makeShareChatEvent({
      share_chat_id: "sc_abc123",
    });
    const ctx = parseFeishuMessageEvent(event as any, "ou_bot_123");
    expect(ctx.content).toBe("[Forwarded message: sc_abc123]");
  });
});

describe("checkBotMentioned – @_all / respondToAtAll gating", () => {
  const BOT_OPEN_ID = "ou_bot_123";

  function makeMinimalEvent(content: string) {
    return {
      message: {
        content,
        message_type: "text",
        mentions: [] as Array<{ key: string; name: string; id: { open_id?: string } }>,
        chat_id: "oc_chat1",
        message_id: "msg_1",
      },
      sender: {
        sender_id: { open_id: "ou_sender", user_id: "u1" },
      },
    };
  }

  it("@_all returns false when respondToAtAll is undefined (default)", () => {
    const event = makeMinimalEvent(JSON.stringify({ text: "@_all hello" }));
    expect(checkBotMentioned(event, BOT_OPEN_ID)).toBe(false);
  });

  it("@_all returns false when respondToAtAll is false", () => {
    const event = makeMinimalEvent(JSON.stringify({ text: "@_all hello" }));
    expect(checkBotMentioned(event, BOT_OPEN_ID, false)).toBe(false);
  });

  it("@_all returns true when respondToAtAll is true", () => {
    const event = makeMinimalEvent(JSON.stringify({ text: "@_all hello" }));
    expect(checkBotMentioned(event, BOT_OPEN_ID, true)).toBe(true);
  });

  it("direct bot mention still works regardless of respondToAtAll", () => {
    const event = makeMinimalEvent(JSON.stringify({ text: "hello" }));
    event.message.mentions = [{ key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } }];
    // Works without respondToAtAll
    expect(checkBotMentioned(event, BOT_OPEN_ID)).toBe(true);
    // Works with respondToAtAll=false
    expect(checkBotMentioned(event, BOT_OPEN_ID, false)).toBe(true);
    // Works with respondToAtAll=true
    expect(checkBotMentioned(event, BOT_OPEN_ID, true)).toBe(true);
  });
});

describe("parseFeishuMessageEvent – @_all respondToAtAll integration", () => {
  const BOT_OPEN_ID = "ou_bot_123";

  it("@_all message returns mentionedBot=false by default (no respondToAtAll)", () => {
    const event = makeEvent("group", [], "@_all hello everyone");
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(false);
  });

  it("@_all message returns mentionedBot=true when respondToAtAll=true is passed", () => {
    const event = makeEvent("group", [], "@_all hello everyone");
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, undefined, true);
    expect(ctx.mentionedBot).toBe(true);
  });

  it("@_all message returns mentionedBot=false when respondToAtAll=false is passed", () => {
    const event = makeEvent("group", [], "@_all hello everyone");
    const ctx = parseFeishuMessageEvent(event as any, BOT_OPEN_ID, undefined, false);
    expect(ctx.mentionedBot).toBe(false);
  });
});
