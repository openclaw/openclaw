import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

const cfg = {
  channels: {
    feishu: {
      appId: "cli_test",
      appSecret: "secret_test",
      groups: {
        oc_topic_chat: {
          groupSessionScope: "group_topic",
        },
        oc_topic_sender_chat: {
          groupSessionScope: "group_topic_sender",
        },
      },
    },
  },
} as ClawdbotConfig;

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
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      ...(params.rootId ? { root_id: params.rootId } : {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
    },
  } as FeishuMessageEvent;
}

describe("getFeishuSequentialKey", () => {
  it.each([
    [createTextEvent({ text: "hello" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/status" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/stop" }), "feishu:default:oc_dm_chat:control"],
    [createTextEvent({ text: "/btw what changed?" }), "feishu:default:oc_dm_chat:btw"],
  ])("resolves sequential key %#", async (event, expected) => {
    await expect(
      getFeishuSequentialKey({
        cfg,
        accountId: "default",
        event,
      }),
    ).resolves.toBe(expected);
  });

  it("keeps /btw on a stable per-chat lane across different message ids", async () => {
    const first = createTextEvent({ text: "/btw one", messageId: "om_message_1" });
    const second = createTextEvent({ text: "/btw two", messageId: "om_message_2" });

    await expect(
      getFeishuSequentialKey({
        cfg,
        accountId: "default",
        event: first,
      }),
    ).resolves.toBe("feishu:default:oc_dm_chat:btw");
    await expect(
      getFeishuSequentialKey({
        cfg,
        accountId: "default",
        event: second,
      }),
    ).resolves.toBe("feishu:default:oc_dm_chat:btw");
  });

  it("falls back to a stable btw lane when the message id is unavailable", async () => {
    const event = createTextEvent({ text: "/btw what changed?" });
    delete (event.message as { message_id?: string }).message_id;

    await expect(
      getFeishuSequentialKey({
        cfg,
        accountId: "default",
        event,
      }),
    ).resolves.toBe("feishu:default:oc_dm_chat:btw");
  });

  it("uses the configured topic session scope for group queue keys", async () => {
    const first = createTextEvent({
      text: "topic one",
      chatId: "oc_topic_chat",
      chatType: "topic_group",
      threadId: "omt_topic_1",
    });
    const second = createTextEvent({
      text: "topic two",
      chatId: "oc_topic_chat",
      chatType: "topic_group",
      threadId: "omt_topic_2",
    });

    await expect(getFeishuSequentialKey({ cfg, accountId: "default", event: first })).resolves.toBe(
      "feishu:default:oc_topic_chat:topic:omt_topic_1",
    );
    await expect(
      getFeishuSequentialKey({ cfg, accountId: "default", event: second }),
    ).resolves.toBe("feishu:default:oc_topic_chat:topic:omt_topic_2");
  });

  it("keeps control lanes scoped within the topic queue", async () => {
    const event = createTextEvent({
      text: "/stop",
      chatId: "oc_topic_chat",
      chatType: "topic_group",
      threadId: "omt_topic_1",
    });

    await expect(getFeishuSequentialKey({ cfg, accountId: "default", event })).resolves.toBe(
      "feishu:default:oc_topic_chat:topic:omt_topic_1:control",
    );
  });

  it("hydrates a missing topic thread id before resolving the queue key", async () => {
    const event = createTextEvent({
      text: "topic",
      chatId: "oc_topic_chat",
      chatType: "topic_group",
      messageId: "om_message_missing_thread",
    });

    await expect(
      getFeishuSequentialKey({
        cfg,
        accountId: "default",
        event,
        fetchMessage: async () => ({
          messageId: "om_message_missing_thread",
          chatId: "oc_topic_chat",
          content: "topic",
          contentType: "text",
          threadId: "omt_hydrated",
        }),
      }),
    ).resolves.toBe("feishu:default:oc_topic_chat:topic:omt_hydrated");
  });

  it("uses topic and sender for group_topic_sender queue keys", async () => {
    const event = createTextEvent({
      text: "topic sender",
      chatId: "oc_topic_sender_chat",
      chatType: "topic_group",
      threadId: "omt_topic_1",
    });

    await expect(getFeishuSequentialKey({ cfg, accountId: "default", event })).resolves.toBe(
      "feishu:default:oc_topic_sender_chat:topic:omt_topic_1:sender:ou_sender_1",
    );
  });
});
