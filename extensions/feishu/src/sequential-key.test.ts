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
    { chatType: "topic_group", rootId: "om-reply", threadId: "omt-topic", topic: "omt-topic" },
    { chatType: "group", rootId: "om-root", threadId: "omt-thread", topic: "om-root" },
  ] as const)("aligns $chatType preparation with routed topic identity", (params) => {
    const event = createTextEvent({ text: "correction" });
    event.message.chat_type = params.chatType;
    event.message.root_id = params.rootId;
    event.message.thread_id = params.threadId;
    expect(
      getFeishuSequentialKey({
        cfg: { channels: { feishu: { groupSessionScope: "group_topic" } } },
        accountId: "default",
        event,
      }),
    ).toBe(`feishu:default:oc_dm_chat:topic:${params.topic}`);
    // A group-scoped session deliberately shares the topic lane.
    expect(
      getFeishuSequentialKey({
        cfg: { channels: { feishu: { groupSessionScope: "group" } } },
        accountId: "default",
        event,
      }),
    ).toBe("feishu:default:oc_dm_chat");
  });

  it("uses group overrides and keeps topic control traffic separate", () => {
    const event = createTextEvent({ text: "/stop" });
    event.message.chat_type = "topic_group";
    event.message.thread_id = "omt-a";
    expect(
      getFeishuSequentialKey({
        cfg: {
          channels: {
            feishu: {
              groupSessionScope: "group",
              groups: {
                oc_dm_chat: { groupSessionScope: "group_topic" },
              },
            },
          },
        },
        accountId: "default",
        event,
      }),
    ).toBe("feishu:default:oc_dm_chat:topic:omt-a:control");
  });

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
