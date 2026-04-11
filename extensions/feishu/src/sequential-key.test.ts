import { describe, expect, it } from "vitest";
import type { GroupSessionScope } from "./bot-content.js";
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
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      ...(params.rootId !== undefined ? { root_id: params.rootId } : {}),
      ...(params.threadId !== undefined ? { thread_id: params.threadId } : {}),
    },
  } as FeishuMessageEvent;
}

describe("getFeishuSequentialKey", () => {
  it.each<[FeishuMessageEvent, string, GroupSessionScope | undefined]>([
    [createTextEvent({ text: "hello" }), "feishu:default:oc_dm_chat", undefined],
    [createTextEvent({ text: "/status" }), "feishu:default:oc_dm_chat", undefined],
    [createTextEvent({ text: "/stop" }), "feishu:default:oc_dm_chat:control", undefined],
    [createTextEvent({ text: "/btw what changed?" }), "feishu:default:oc_dm_chat:btw", undefined],
    [
      createTextEvent({
        text: "hello",
        chatId: "oc_topic_chat",
        chatType: "group",
        rootId: "om_root_1",
      }),
      "feishu:default:oc_topic_chat:topic:om_root_1",
      "group_topic",
    ],
    [
      createTextEvent({
        text: "hello",
        chatId: "oc_topic_chat",
        chatType: "group",
        threadId: "omt_thread_1",
      }),
      "feishu:default:oc_topic_chat:topic:omt_thread_1",
      "group_topic",
    ],
    [
      createTextEvent({
        text: "hello",
        chatId: "oc_topic_chat",
        chatType: "group",
        rootId: "om_root_a",
        threadId: "omt_thread_b",
      }),
      "feishu:default:oc_topic_chat:topic:om_root_a",
      "group_topic_sender",
    ],
    [
      createTextEvent({
        text: "hello",
        chatId: "oc_topic_chat",
        chatType: "group",
        rootId: "   ",
        threadId: "omt_thread_b",
      }),
      "feishu:default:oc_topic_chat:topic:omt_thread_b",
      "group_topic",
    ],
    [
      createTextEvent({ text: "hello", chatId: "oc_regular_group", chatType: "group" }),
      "feishu:default:oc_regular_group",
      "group",
    ],
  ])("resolves sequential key %#", (event, expected, groupSessionScope) => {
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        groupSessionScope,
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
      chatType: "group",
      rootId: "om_topic_root_1",
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        groupSessionScope: "group_topic",
      }),
    ).toBe("feishu:default:oc_topic_chat:control");
  });

  it("keeps /btw on a chat-wide out-of-band lane even inside a topic group", () => {
    const event = createTextEvent({
      text: "/btw what changed?",
      chatId: "oc_topic_chat",
      chatType: "group",
      rootId: "om_topic_root_2",
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        groupSessionScope: "group_topic",
      }),
    ).toBe("feishu:default:oc_topic_chat:btw");
  });

  it("runs different topics on independent lanes within the same chat", () => {
    const first = createTextEvent({
      text: "hello from topic 1",
      chatId: "oc_topic_chat",
      chatType: "group",
      rootId: "om_topic_root_1",
      messageId: "om_message_topic_1",
    });
    const second = createTextEvent({
      text: "hello from topic 2",
      chatId: "oc_topic_chat",
      chatType: "group",
      rootId: "om_topic_root_2",
      messageId: "om_message_topic_2",
    });

    const firstKey = getFeishuSequentialKey({
      accountId: "default",
      event: first,
      groupSessionScope: "group_topic",
    });
    const secondKey = getFeishuSequentialKey({
      accountId: "default",
      event: second,
      groupSessionScope: "group_topic",
    });

    expect(firstKey).toBe("feishu:default:oc_topic_chat:topic:om_topic_root_1");
    expect(secondKey).toBe("feishu:default:oc_topic_chat:topic:om_topic_root_2");
    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps normal-group quote replies on the chat-wide lane even when root_id is present (#32980)", () => {
    // Regression guard: in scope="group" (or scope="group_sender"), a Feishu
    // quote reply in a normal group still carries `root_id` pointing at the
    // quoted message. The queue key must NOT split into a `:topic:` lane,
    // because normal groups share a single session store and rely on per-chat
    // FIFO. This mirrors the bot.test.ts assertion
    // "replies to triggering message in normal group even when root_id is
    //  present (#32980)".
    const quoteReplyInGroup = createTextEvent({
      text: "hello in normal group",
      chatId: "oc_normal_group",
      chatType: "group",
      rootId: "om_quoted_message",
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: quoteReplyInGroup,
        groupSessionScope: "group",
      }),
    ).toBe("feishu:default:oc_normal_group");

    // Same guarantee for group_sender: the session is per-sender, not
    // per-topic, so the queue lane must stay chat-wide.
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: quoteReplyInGroup,
        groupSessionScope: "group_sender",
      }),
    ).toBe("feishu:default:oc_normal_group");

    // Default (undefined scope → treat as "group"): same guarantee.
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: quoteReplyInGroup,
      }),
    ).toBe("feishu:default:oc_normal_group");
  });

  it("keeps DM quote replies on the chat-wide lane even when a topic scope leaks in", () => {
    // Regression guard for the DM case flagged by Codex on PR #64920:
    // Feishu DMs can carry `root_id` for quote replies (see the
    // "propagates parent/root message ids into inbound context for reply
    // reconstruction" fixture in bot.test.ts around line 721, which uses
    // `chat_type: "p2p"` + `root_id` + `parent_id`). If a global or
    // wildcard `groupSessionScope: "group_topic"` / `"group_topic_sender"`
    // leaks into the DM path, the queue key must still stay chat-wide and
    // preserve per-chat FIFO ordering.
    const dmQuoteReply = createTextEvent({
      text: "reply text",
      chatId: "oc_dm_chat",
      chatType: "p2p",
      rootId: "om_root_001",
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: dmQuoteReply,
        groupSessionScope: "group_topic",
      }),
    ).toBe("feishu:default:oc_dm_chat");

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: dmQuoteReply,
        groupSessionScope: "group_topic_sender",
      }),
    ).toBe("feishu:default:oc_dm_chat");

    // Also cover the `private` DM sub-type — same defense applies.
    const privateDmQuoteReply = createTextEvent({
      text: "reply text",
      chatId: "oc_private_dm",
      chatType: "private",
      rootId: "om_root_002",
      threadId: "omt_thread_x",
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: privateDmQuoteReply,
        groupSessionScope: "group_topic_sender",
      }),
    ).toBe("feishu:default:oc_private_dm");
  });
});
