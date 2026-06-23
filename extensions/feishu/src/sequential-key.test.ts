// Feishu tests cover sequential key plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { getFeishuSequentialKey } from "./sequential-key.js";
import type { FeishuConfig } from "./types.js";

function createFeishuConfig(overrides: Record<string, unknown> = {}): FeishuConfig {
  return FeishuConfigSchema.parse(overrides);
}

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
  chatType?: FeishuMessageEvent["message"]["chat_type"];
  rootId?: string;
  threadId?: string;
  senderOpenId?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: params.senderOpenId ?? "ou_sender_1",
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it.each([
    [
      "default group scope",
      createTextEvent({ text: "hello", chatId: "oc_group", chatType: "group" }),
      createFeishuConfig(),
      "feishu:default:oc_group",
    ],
    [
      "group_sender scope",
      createTextEvent({
        text: "hello",
        chatId: "oc_group",
        chatType: "group",
        senderOpenId: "ou_sender_a",
      }),
      createFeishuConfig({ groupSessionScope: "group_sender" }),
      "feishu:default:oc_group:sender:ou_sender_a",
    ],
    [
      "group_topic scope",
      createTextEvent({
        text: "hello",
        chatId: "oc_group",
        chatType: "group",
        rootId: "om_root_topic",
      }),
      createFeishuConfig({ groupSessionScope: "group_topic" }),
      "feishu:default:oc_group:topic:om_root_topic",
    ],
    [
      "group_topic_sender scope",
      createTextEvent({
        text: "hello",
        chatId: "oc_group",
        chatType: "group",
        rootId: "om_root_topic",
        senderOpenId: "ou_sender_a",
      }),
      createFeishuConfig({ groupSessionScope: "group_topic_sender" }),
      "feishu:default:oc_group:topic:om_root_topic:sender:ou_sender_a",
    ],
    [
      "legacy topicSessionMode scope",
      createTextEvent({
        text: "hello",
        chatId: "oc_group",
        chatType: "group",
        rootId: "om_root_topic",
      }),
      createFeishuConfig({ topicSessionMode: "enabled" }),
      "feishu:default:oc_group:topic:om_root_topic",
    ],
  ] as const)(
    "resolves %s from group session routing",
    async (_name, event, feishuCfg, expected) => {
      await expect(
        Promise.resolve(
          getFeishuSequentialKey({
            accountId: "default",
            event,
            feishuCfg,
          }),
        ),
      ).resolves.toBe(expected);
    },
  );

  it("lets group config override top-level group session scope", async () => {
    const event = createTextEvent({
      text: "hello",
      chatId: "oc_group",
      chatType: "group",
      rootId: "om_root_topic",
      senderOpenId: "ou_sender_a",
    });

    await expect(
      Promise.resolve(
        getFeishuSequentialKey({
          accountId: "default",
          event,
          feishuCfg: createFeishuConfig({
            groupSessionScope: "group",
            groups: {
              oc_group: {
                groupSessionScope: "group_topic_sender",
              },
            },
          }),
        }),
      ),
    ).resolves.toBe("feishu:default:oc_group:topic:om_root_topic:sender:ou_sender_a");
  });

  it("hydrates native topic group starter thread id before resolving the queue key", async () => {
    const fetchMessage = vi.fn(async () => ({
      messageId: "om_topic_starter",
      chatId: "oc_group",
      content: "topic starter",
      contentType: "text",
      threadId: "omt_native_topic",
    }));

    await expect(
      Promise.resolve(
        getFeishuSequentialKey({
          accountId: "default",
          cfg: {},
          event: createTextEvent({
            text: "topic starter",
            messageId: "om_topic_starter",
            chatId: "oc_group",
            chatType: "topic_group",
          }),
          feishuCfg: createFeishuConfig({
            groupSessionScope: "group_topic",
            replyInThread: "enabled",
          }),
          fetchMessage,
        }),
      ),
    ).resolves.toMatchObject({
      key: "feishu:default:oc_group:topic:omt_native_topic",
      event: {
        message: {
          thread_id: "omt_native_topic",
        },
      },
    });
    expect(fetchMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps native topic reply on the same hydrated topic key", async () => {
    await expect(
      Promise.resolve(
        getFeishuSequentialKey({
          accountId: "default",
          event: createTextEvent({
            text: "topic reply",
            messageId: "om_topic_reply",
            chatId: "oc_group",
            chatType: "topic_group",
            rootId: "om_topic_starter",
            threadId: "omt_native_topic",
          }),
          feishuCfg: createFeishuConfig({
            groupSessionScope: "group_topic",
            replyInThread: "enabled",
          }),
        }),
      ),
    ).resolves.toBe("feishu:default:oc_group:topic:omt_native_topic");
  });

  it("falls back to the available topic identity when hydration fails", async () => {
    const log = vi.fn();

    await expect(
      Promise.resolve(
        getFeishuSequentialKey({
          accountId: "default",
          cfg: {},
          event: createTextEvent({
            text: "topic starter",
            messageId: "om_topic_starter",
            chatId: "oc_group",
            chatType: "topic_group",
          }),
          feishuCfg: createFeishuConfig({
            groupSessionScope: "group_topic",
            replyInThread: "enabled",
          }),
          fetchMessage: vi.fn(async () => {
            throw new Error("api unavailable");
          }),
          log,
        }),
      ),
    ).resolves.toEqual({
      key: "feishu:default:oc_group:topic:om_topic_starter",
      waitForTaskBeforeNextChatKey: true,
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("falls back when native topic group starter hydration times out", async () => {
    vi.useFakeTimers();
    const fetchMessage = vi.fn(async () => await new Promise<never>(() => {}));
    const result = Promise.resolve(
      getFeishuSequentialKey({
        accountId: "default",
        cfg: {},
        event: createTextEvent({
          text: "topic starter",
          messageId: "om_topic_starter",
          chatId: "oc_group",
          chatType: "topic_group",
        }),
        feishuCfg: createFeishuConfig({
          groupSessionScope: "group_topic",
          replyInThread: "enabled",
        }),
        fetchMessage,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_500);

    await expect(result).resolves.toEqual({
      key: "feishu:default:oc_group:topic:om_topic_starter",
      waitForTaskBeforeNextChatKey: true,
    });
  });

  it.each(["/stop", "/btw status"] as const)(
    "keeps %s on the chat-wide lane without hydration",
    async (text) => {
      const fetchMessage = vi.fn(async () => null);

      await expect(
        Promise.resolve(
          getFeishuSequentialKey({
            accountId: "default",
            cfg: {},
            event: createTextEvent({
              text,
              chatId: "oc_group",
              chatType: "topic_group",
            }),
            feishuCfg: createFeishuConfig({ groupSessionScope: "group_topic" }),
            fetchMessage,
          }),
        ),
      ).resolves.toBe(
        text === "/stop" ? "feishu:default:oc_group:control" : "feishu:default:oc_group:btw",
      );
      expect(fetchMessage).not.toHaveBeenCalled();
    },
  );
});
