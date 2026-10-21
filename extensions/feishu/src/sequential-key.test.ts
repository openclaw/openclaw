import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(text: string, messageId = "om_message_1"): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: "ou_sender_1", user_id: "ou_user_1" }, sender_type: "user" },
    message: {
      message_id: messageId,
      chat_id: "oc_dm_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  } as FeishuMessageEvent;
}

function key(
  event: FeishuMessageEvent,
  options: { botOpenId?: string; preparedContent?: string } = {},
) {
  return getFeishuSequentialKey({ accountId: "default", event, ...options });
}

describe("getFeishuSequentialKey", () => {
  it.each([
    [createTextEvent("hello"), "feishu:default:oc_dm_chat"],
    [createTextEvent("/status"), "feishu:default:oc_dm_chat"],
    [createTextEvent("/stop"), "feishu:default:oc_dm_chat:control"],
  ])("resolves sequential key %#", (event, expected) => {
    expect(key(event)).toBe(expected);
  });

  it("classifies the prepared batch body instead of only its last event", () => {
    const event = createTextEvent("@_bot/stop");
    event.message.mentions = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];
    expect(
      key(event, {
        botOpenId: "ou_bot",
        preparedContent: "first message\n@_bot/stop",
      }),
    ).toBe("feishu:default:oc_dm_chat");
  });

  it("keeps /btw on a stable per-chat lane across different message ids", () => {
    const first = createTextEvent("/btw one", "om_message_1");
    const second = createTextEvent("/btw two", "om_message_2");

    expect(key(first)).toBe("feishu:default:oc_dm_chat:btw");
    expect(key(second)).toBe("feishu:default:oc_dm_chat:btw");
  });

  it("falls back to a stable btw lane when the message id is unavailable", () => {
    const event = createTextEvent("/btw what changed?");
    delete (event.message as { message_id?: string }).message_id;

    expect(key(event)).toBe("feishu:default:oc_dm_chat:btw");
  });

  it("keeps an empty group message with bot mentions on its normal chat lane", () => {
    const event = createTextEvent("");
    event.message.chat_type = "group";
    event.message.content = "";
    event.message.mentions = [{ key: "@_bot_1", id: { open_id: "ou_bot_1" }, name: "OpenClaw" }];

    expect(key(event, { botOpenId: "ou_bot_1" })).toBe("feishu:default:oc_dm_chat");
  });
});
