import { afterEach, describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import {
  clearFeishuBotOpenIdsForTesting,
  setFeishuBotOpenIdForTesting,
  shouldSkipDispatchForMentionPolicy,
} from "./monitor.js";

function makeGroupEvent(params: {
  mentions?: Array<{ openId?: string; name: string; key: string }>;
  messageType?: "text" | "post";
  content?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        user_id: "u1",
        open_id: "ou_sender",
      },
    },
    message: {
      message_id: "msg_1",
      chat_id: "oc_group_1",
      chat_type: "group",
      message_type: params.messageType ?? "text",
      content:
        params.content ??
        JSON.stringify({
          text: "hello",
        }),
      mentions: (params.mentions ?? []).map((mention) => ({
        key: mention.key,
        name: mention.name,
        id: { open_id: mention.openId },
      })),
    },
  };
}

afterEach(() => {
  clearFeishuBotOpenIdsForTesting();
});

describe("shouldSkipDispatchForMentionPolicy", () => {
  it("skips main when only a sibling bot is mentioned in a group message", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_flink", name: "flink-sre", key: "@_user_1" }],
        }),
      }),
    ).toBe(true);
  });

  it("does not skip main when main itself is mentioned", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "main", key: "@_user_1" },
            { openId: "ou_flink", name: "flink-sre", key: "@_user_2" },
          ],
        }),
      }),
    ).toBe(false);
  });

  it("does not skip non-main accounts", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_main", name: "main", key: "@_user_1" }],
        }),
      }),
    ).toBe(false);
  });

  it("detects sibling bot mentions in post messages", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          messageType: "post",
          content: JSON.stringify({
            content: [
              [{ tag: "at", user_id: "ou_starrocks", user_name: "starrocks-sre" }],
              [{ tag: "text", text: "排查一下" }],
            ],
          }),
        }),
      }),
    ).toBe(true);
  });

  it("skips child dispatch when both main and the child are mentioned", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_main", name: "main", key: "@_user_1" },
            { openId: "ou_flink", name: "flink-sre", key: "@_user_2" },
          ],
        }),
      }),
    ).toBe(true);
  });

  it("does not skip child dispatch when only the child is mentioned", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [{ openId: "ou_flink", name: "flink-sre", key: "@_user_1" }],
        }),
      }),
    ).toBe(false);
  });

  it("keeps main dispatch when multiple specialist bots are mentioned without main", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "main",
        currentBotOpenId: "ou_main",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_flink", name: "flink-sre", key: "@_user_1" },
            { openId: "ou_starrocks", name: "starrocks-sre", key: "@_user_2" },
          ],
        }),
      }),
    ).toBe(false);
  });

  it("skips specialist dispatch when multiple specialist bots are mentioned without main", () => {
    setFeishuBotOpenIdForTesting("main", "ou_main");
    setFeishuBotOpenIdForTesting("flink-sre", "ou_flink");
    setFeishuBotOpenIdForTesting("starrocks-sre", "ou_starrocks");

    expect(
      shouldSkipDispatchForMentionPolicy({
        accountId: "flink-sre",
        currentBotOpenId: "ou_flink",
        event: makeGroupEvent({
          mentions: [
            { openId: "ou_flink", name: "flink-sre", key: "@_user_1" },
            { openId: "ou_starrocks", name: "starrocks-sre", key: "@_user_2" },
          ],
        }),
      }),
    ).toBe(true);
  });
});
