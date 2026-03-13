import { describe, expect, it } from "vitest";

import { parseFeishuMessageEvent } from "./bot";

const BOT_OPEN_ID = "ou_bot";

function makeEvent(
  chatType: "p2p" | "group",
  mentions: Array<{ key: string; name: string; id: { open_id: string } }>,
) {
  return {
    header: {
      event_id: "evt_1",
      token: "t",
      create_time: "0",
      event_type: "im.message.receive_v1",
      tenant_key: "tk",
      app_id: "cli_x",
    },
    event: {
      sender: {
        sender_id: { open_id: "ou_sender" },
        sender_type: "user",
      },
      message: {
        message_id: "m1",
        root_id: null,
        parent_id: null,
        create_time: "0",
        chat_id: "c1",
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        mentions,
      },
    },
  };
}

describe("parseFeishuMessageEvent – mentionedBot", () => {
  it("falls back to sender user_id when open_id is missing", () => {
    const event = makeEvent("p2p", []);
    (event as any).event.sender.sender_id = { user_id: "u_mobile_only" };

    const ctx = parseFeishuMessageEvent((event as any).event, BOT_OPEN_ID);
    expect(ctx.senderOpenId).toBe("u_mobile_only");
    expect(ctx.senderId).toBe("u_mobile_only");
  });

  it("returns mentionedBot=true when bot is mentioned", () => {
    const event = makeEvent("group", [{ key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } }]);
    const ctx = parseFeishuMessageEvent((event as any).event, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=true even when mention display name differs", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "BotName（别名）", id: { open_id: BOT_OPEN_ID } },
    ]);
    const ctx = parseFeishuMessageEvent((event as any).event, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(true);
  });

  it("returns mentionedBot=false when only other users are mentioned", () => {
    const event = makeEvent("group", [{ key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } }]);
    const ctx = parseFeishuMessageEvent((event as any).event, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(false);
  });

  it("returns mentionedBot=false when botOpenId is undefined (unknown bot)", () => {
    const event = makeEvent("group", [{ key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } }]);
    const ctx = parseFeishuMessageEvent((event as any).event, undefined);
    expect(ctx.mentionedBot).toBe(false);
  });
});
