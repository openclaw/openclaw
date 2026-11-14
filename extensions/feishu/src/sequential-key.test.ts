import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { createFeishuTestEvent } from "./bot.test-support.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(text: string, messageId = "om_message_1"): FeishuMessageEvent {
  return createFeishuTestEvent({
    messageId,
    text,
    chatId: "oc_dm_chat",
    senderOpenId: "ou_sender_1",
    senderUserId: "ou_user_1",
    senderType: "user",
  });
}

function key(
  event: FeishuMessageEvent,
  options: { botOpenId?: string; preparedContent?: string } = {},
) {
  return getFeishuSequentialKey({
    accountId: "default",
    event,
    isControlCommandMessage,
    ...options,
  });
}

describe("getFeishuSequentialKey", () => {
  it.each([
    {
      scope: "group_topic",
      chatType: "topic_group",
      root: "om-root",
      thread: "omt-native",
      expected: ":topic:omt-native",
    },
    {
      scope: "group_topic",
      chatType: "group",
      root: "om-root",
      thread: "omt-native",
      expected: ":topic:om-root",
    },
    {
      scope: "group_topic",
      chatType: "group",
      root: "",
      thread: "omt-native",
      expected: ":topic:omt-native",
    },
    {
      scope: "group_topic_sender",
      chatType: "topic_group",
      root: "",
      thread: "omt-native",
      expected: ":topic:omt-native:sender:ou_sender_1",
    },
    {
      scope: "group_sender",
      chatType: "group",
      root: "om-root",
      thread: "omt-native",
      expected: "",
    },
    { scope: "group_topic", chatType: "p2p", root: "om-root", thread: "omt-native", expected: "" },
  ] as const)("uses the existing session identity: $scope/$chatType/$root", (scenario) => {
    const event = createTextEvent("hello");
    event.message.chat_type = scenario.chatType;
    event.message.root_id = scenario.root;
    event.message.thread_id = scenario.thread;
    const cfg: ClawdbotConfig = { channels: { feishu: { groupSessionScope: scenario.scope } } };
    expect(
      getFeishuSequentialKey({ cfg, accountId: "other", event, isControlCommandMessage }),
    ).toBe(`feishu:other:oc_dm_chat${scenario.expected}`);
  });

  it("honors account, group override and legacy topic configuration", () => {
    const event = createTextEvent("hello");
    event.message.chat_type = "group";
    event.message.root_id = "om-root";
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupSessionScope: "group",
          accounts: {
            work: { topicSessionMode: "enabled", groupSessionScope: "group_topic_sender" },
          },
          groups: { oc_dm_chat: { topicSessionMode: "enabled", groupSessionScope: "group_topic" } },
        },
      },
    };
    expect(getFeishuSequentialKey({ cfg, accountId: "work", event, isControlCommandMessage })).toBe(
      "feishu:work:oc_dm_chat:topic:om-root",
    );
    const legacy: ClawdbotConfig = { channels: { feishu: { topicSessionMode: "enabled" } } };
    expect(
      getFeishuSequentialKey({ cfg: legacy, accountId: "default", event, isControlCommandMessage }),
    ).toBe("feishu:default:oc_dm_chat:topic:om-root");
  });

  it.each([
    [createTextEvent("hello"), "feishu:default:oc_dm_chat"],
    [createTextEvent("/status"), "feishu:default:oc_dm_chat:commands"],
    [createTextEvent("/new"), "feishu:default:oc_dm_chat:commands"],
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
