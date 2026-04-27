import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";
import type { FeishuConfig } from "./types.js";

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
  chatType?: "p2p" | "group" | "topic_group";
  rootId?: string;
  threadId?: string;
  senderOpenId?: string;
  senderUserId?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: params.senderOpenId ?? "ou_sender_1",
        user_id: params.senderUserId ?? "ou_user_1",
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

function createFeishuConfig(params: Partial<FeishuConfig>): FeishuConfig {
  return params as unknown as FeishuConfig;
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

  it("keeps group messages on the per-chat lane by default", () => {
    const event = createTextEvent({
      text: "hello",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_1",
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        feishuCfg: createFeishuConfig({}),
      }),
    ).toBe("feishu:default:oc_group");
  });

  it("scopes group_sender queues by sender", () => {
    const feishuCfg = createFeishuConfig({ groupSessionScope: "group_sender" });
    const first = createTextEvent({
      text: "one",
      chatId: "oc_group",
      chatType: "group",
      senderOpenId: "ou_sender_1",
    });
    const otherSender = createTextEvent({
      text: "two",
      chatId: "oc_group",
      chatType: "group",
      senderOpenId: "ou_sender_2",
    });

    expect(getFeishuSequentialKey({ accountId: "default", event: first, feishuCfg })).toBe(
      "feishu:default:oc_group:sender:ou_sender_1",
    );
    expect(getFeishuSequentialKey({ accountId: "default", event: otherSender, feishuCfg })).toBe(
      "feishu:default:oc_group:sender:ou_sender_2",
    );
  });

  it("honors legacy topicSessionMode when resolving group queue lanes", () => {
    const feishuCfg = createFeishuConfig({ topicSessionMode: "enabled" });
    const event = createTextEvent({
      text: "hello",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_1",
    });

    expect(getFeishuSequentialKey({ accountId: "default", event, feishuCfg })).toBe(
      "feishu:default:oc_group:topic:om_root_1",
    );
  });

  it("scopes group_topic queues by thread topic", () => {
    const feishuCfg = createFeishuConfig({ groupSessionScope: "group_topic" });
    const first = createTextEvent({
      text: "one",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_1",
      messageId: "om_message_1",
    });
    const sameTopic = createTextEvent({
      text: "two",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_1",
      messageId: "om_message_2",
    });
    const otherTopic = createTextEvent({
      text: "three",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_2",
      messageId: "om_message_3",
    });

    expect(getFeishuSequentialKey({ accountId: "default", event: first, feishuCfg })).toBe(
      "feishu:default:oc_group:topic:om_root_1",
    );
    expect(getFeishuSequentialKey({ accountId: "default", event: sameTopic, feishuCfg })).toBe(
      "feishu:default:oc_group:topic:om_root_1",
    );
    expect(getFeishuSequentialKey({ accountId: "default", event: otherTopic, feishuCfg })).toBe(
      "feishu:default:oc_group:topic:om_root_2",
    );
  });

  it("scopes group_topic_sender queues by thread topic and sender", () => {
    const feishuCfg = createFeishuConfig({ groupSessionScope: "group_topic_sender" });
    const first = createTextEvent({
      text: "one",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_1",
      senderOpenId: "ou_sender_1",
    });
    const otherSender = createTextEvent({
      text: "two",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_1",
      senderOpenId: "ou_sender_2",
    });

    expect(getFeishuSequentialKey({ accountId: "default", event: first, feishuCfg })).toBe(
      "feishu:default:oc_group:topic:om_root_1:sender:ou_sender_1",
    );
    expect(getFeishuSequentialKey({ accountId: "default", event: otherSender, feishuCfg })).toBe(
      "feishu:default:oc_group:topic:om_root_1:sender:ou_sender_2",
    );
  });

  it("honors per-group session scope overrides", () => {
    const feishuCfg = createFeishuConfig({
      groupSessionScope: "group",
      groups: {
        oc_group: { groupSessionScope: "group_topic" },
      },
    });
    const event = createTextEvent({
      text: "hello",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_1",
    });

    expect(getFeishuSequentialKey({ accountId: "default", event, feishuCfg })).toBe(
      "feishu:default:oc_group:topic:om_root_1",
    );
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
});
