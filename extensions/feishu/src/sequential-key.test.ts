import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
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

  // --- DM topic parallelism ---

  it("returns topic queue key for DM message with root_id", () => {
    const event = createTextEvent({
      text: "hello",
      rootId: "om_root_abc",
    });
    expect(getFeishuSequentialKey({ accountId: "default", event })).toBe(
      "feishu:default:oc_dm_chat:topic:om_root_abc",
    );
  });

  it("returns topic queue key for DM message with thread_id", () => {
    const event = createTextEvent({
      text: "hello",
      threadId: "omt_thread_xyz",
    });
    expect(getFeishuSequentialKey({ accountId: "default", event })).toBe(
      "feishu:default:oc_dm_chat:topic:omt_thread_xyz",
    );
  });

  it("prefers root_id over thread_id for DM topic key", () => {
    const event = createTextEvent({
      text: "hello",
      rootId: "om_root_1",
      threadId: "omt_thread_2",
    });
    expect(getFeishuSequentialKey({ accountId: "default", event })).toBe(
      "feishu:default:oc_dm_chat:topic:om_root_1",
    );
  });

  it("does NOT apply topic parallelism in group chats", () => {
    const event = createTextEvent({
      text: "hello",
      chatType: "group",
      rootId: "om_root_group",
    });
    expect(getFeishuSequentialKey({ accountId: "default", event })).toBe(
      "feishu:default:oc_dm_chat",
    );
  });

  it("ignores empty/whitespace root_id", () => {
    const event = createTextEvent({
      text: "hello",
      rootId: "  ",
    });
    expect(getFeishuSequentialKey({ accountId: "default", event })).toBe(
      "feishu:default:oc_dm_chat",
    );
  });

  it("routes /stop to control lane even within a DM topic", () => {
    const event = createTextEvent({
      text: "/stop",
      rootId: "om_root_abc",
    });
    expect(getFeishuSequentialKey({ accountId: "default", event })).toBe(
      "feishu:default:oc_dm_chat:topic:om_root_abc:control",
    );
  });

  it("routes /btw to btw lane even within a DM topic", () => {
    const event = createTextEvent({
      text: "/btw something",
      rootId: "om_root_abc",
    });
    expect(getFeishuSequentialKey({ accountId: "default", event })).toBe(
      "feishu:default:oc_dm_chat:topic:om_root_abc:btw",
    );
  });
});
