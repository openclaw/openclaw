// Feishu tests cover sequential key plugin behavior.
import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_sender_1",
        user_id: "ou_user_1",
      },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId ?? "om_message_1",
      chat_id: params.chatId ?? "oc_dm_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
    },
  } as FeishuMessageEvent;
}

describe("getFeishuSequentialKey", () => {
  it.each([
    [createTextEvent({ text: "hello" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/status" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/stop" }), "feishu:default:oc_dm_chat:control"],
  ])("resolves sequential key %#", (event, expected) => {
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe(expected);
  });

  it("classifies the prepared batch body instead of only its last event", () => {
    const event = createTextEvent({ text: "@_bot/stop" });
    event.message.mentions = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot",
        preparedContent: "first message\n@_bot/stop",
      }),
    ).toBe("feishu:default:oc_dm_chat");
  });

  it("keeps /btw on a stable per-chat lane across different message ids", () => {
    const first = createTextEvent({ text: "/btw one", messageId: "om_message_1" });
    const second = createTextEvent({ text: "/btw two", messageId: "om_message_2" });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: first,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: second,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
  });

  it("falls back to a stable btw lane when the message id is unavailable", () => {
    const event = createTextEvent({ text: "/btw what changed?" });
    delete (event.message as { message_id?: string }).message_id;

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
  });

  it("keeps ordinary group messages on the chat lane", () => {
    const root = createTextEvent({ text: "hello", messageId: "om_root" });
    root.message.chat_type = "group";
    const reply = createTextEvent({ text: "reply", messageId: "om_reply" });
    reply.message.chat_type = "group";
    reply.message.root_id = "om_root";

    expect(getFeishuSequentialKey({ accountId: "default", event: root })).toBe(
      "feishu:default:oc_dm_chat",
    );
    expect(getFeishuSequentialKey({ accountId: "default", event: reply })).toBe(
      "feishu:default:oc_dm_chat",
    );
  });

  it("keeps native topic starters and replies in the topic lane", () => {
    const root = createTextEvent({ text: "topic starter", messageId: "om_starter" });
    root.message.chat_type = "topic_group";
    root.message.root_id = "omt_topic";
    const reply = createTextEvent({ text: "topic reply", messageId: "om_reply" });
    reply.message.chat_type = "topic_group";
    reply.message.root_id = "om_starter";
    reply.message.thread_id = "omt_topic";

    const other = createTextEvent({ text: "other topic", messageId: "om_other" });
    other.message.chat_type = "topic_group";
    other.message.root_id = "omt_other";

    expect(getFeishuSequentialKey({ accountId: "default", event: root })).toBe(
      "feishu:default:oc_dm_chat:topic:omt_topic",
    );
    expect(getFeishuSequentialKey({ accountId: "default", event: reply })).toBe(
      "feishu:default:oc_dm_chat:topic:omt_topic",
    );
    expect(getFeishuSequentialKey({ accountId: "default", event: other })).toBe(
      "feishu:default:oc_dm_chat:topic:omt_other",
    );
  });

  it("keeps an empty group message with bot mentions on its normal chat lane", () => {
    const event = createTextEvent({ text: "" });
    event.message.chat_type = "group";
    event.message.content = "";
    event.message.mentions = [
      {
        key: "@_bot_1",
        id: { open_id: "ou_bot_1" },
        name: "OpenClaw",
      },
    ];

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot_1",
      }),
    ).toBe("feishu:default:oc_dm_chat");
  });
});
