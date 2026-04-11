import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
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
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      ...(params.rootId !== undefined ? { root_id: params.rootId } : {}),
      ...(params.threadId !== undefined ? { thread_id: params.threadId } : {}),
    },
  } as FeishuMessageEvent;
}

describe("getFeishuSequentialKey", () => {
  it.each([
    [createTextEvent({ text: "hello" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/status" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/stop" }), "feishu:default:oc_dm_chat:control"],
    [createTextEvent({ text: "/btw what changed?" }), "feishu:default:oc_dm_chat:btw"],
    [
      createTextEvent({ text: "hello", chatId: "oc_topic_chat", rootId: "om_root_1" }),
      "feishu:default:oc_topic_chat:topic:om_root_1",
    ],
    [
      createTextEvent({ text: "hello", chatId: "oc_topic_chat", threadId: "omt_thread_1" }),
      "feishu:default:oc_topic_chat:topic:omt_thread_1",
    ],
    [
      createTextEvent({
        text: "hello",
        chatId: "oc_topic_chat",
        rootId: "om_root_a",
        threadId: "omt_thread_b",
      }),
      "feishu:default:oc_topic_chat:topic:om_root_a",
    ],
    [
      createTextEvent({
        text: "hello",
        chatId: "oc_topic_chat",
        rootId: "   ",
        threadId: "omt_thread_b",
      }),
      "feishu:default:oc_topic_chat:topic:omt_thread_b",
    ],
    [
      createTextEvent({ text: "hello", chatId: "oc_regular_group" }),
      "feishu:default:oc_regular_group",
    ],
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

  it("keeps /stop on a chat-wide control lane even inside a topic group", () => {
    const event = createTextEvent({
      text: "/stop",
      chatId: "oc_topic_chat",
      rootId: "om_topic_root_1",
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe("feishu:default:oc_topic_chat:control");
  });

  it("keeps /btw on a chat-wide out-of-band lane even inside a topic group", () => {
    const event = createTextEvent({
      text: "/btw what changed?",
      chatId: "oc_topic_chat",
      rootId: "om_topic_root_2",
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe("feishu:default:oc_topic_chat:btw");
  });

  it("runs different topics on independent lanes within the same chat", () => {
    const first = createTextEvent({
      text: "hello from topic 1",
      chatId: "oc_topic_chat",
      rootId: "om_topic_root_1",
      messageId: "om_message_topic_1",
    });
    const second = createTextEvent({
      text: "hello from topic 2",
      chatId: "oc_topic_chat",
      rootId: "om_topic_root_2",
      messageId: "om_message_topic_2",
    });

    const firstKey = getFeishuSequentialKey({
      accountId: "default",
      event: first,
    });
    const secondKey = getFeishuSequentialKey({
      accountId: "default",
      event: second,
    });

    expect(firstKey).toBe("feishu:default:oc_topic_chat:topic:om_topic_root_1");
    expect(secondKey).toBe("feishu:default:oc_topic_chat:topic:om_topic_root_2");
    expect(firstKey).not.toBe(secondKey);
  });
});
