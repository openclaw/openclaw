// Feishu tests cover sequential key plugin behavior.
import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
  chatType?: FeishuMessageEvent["message"]["chat_type"];
  rootId?: string;
  threadId?: string;
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
      chat_type: params.chatType ?? "p2p",
      ...(params.rootId ? { root_id: params.rootId } : {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
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
    [createTextEvent({ text: "/btw what changed?" }), "feishu:default:oc_dm_chat:btw"],
  ])("resolves sequential key %#", (event, expected) => {
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe(expected);
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

  it("uses native topic ids as the default lane for Feishu topic groups", () => {
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: createTextEvent({
          text: "topic one",
          chatId: "oc_topic_group",
          chatType: "topic_group",
          rootId: "om_topic_starter",
          threadId: "omt_topic_1",
        }),
      }),
    ).toBe("feishu:default:oc_topic_group:topic:omt_topic_1");
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: createTextEvent({
          text: "topic two",
          chatId: "oc_topic_group",
          chatType: "topic_group",
          rootId: "om_other_topic_starter",
          threadId: "omt_topic_2",
        }),
      }),
    ).toBe("feishu:default:oc_topic_group:topic:omt_topic_2");
  });

  it("honors explicit chat-scoped topic group configuration for queue keys", () => {
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        cfg: {
          channels: {
            feishu: {
              groups: {
                oc_topic_group: {
                  groupSessionScope: "group",
                },
              },
            },
          },
        },
        event: createTextEvent({
          text: "topic one",
          chatId: "oc_topic_group",
          chatType: "topic_group",
          threadId: "omt_topic_1",
        }),
      }),
    ).toBe("feishu:default:oc_topic_group");
  });
});
