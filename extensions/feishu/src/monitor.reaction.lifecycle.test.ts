import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  resolveReactionSyntheticEvent,
  type FeishuReactionCreatedEvent,
} from "./monitor.account.js";

const cfg = {} as ClawdbotConfig;

function makeReactionEvent(
  overrides: Partial<FeishuReactionCreatedEvent> = {},
): FeishuReactionCreatedEvent {
  return {
    message_id: "om_msg1",
    reaction_type: { emoji_type: "THUMBSUP" },
    operator_type: "user",
    user_id: { open_id: "ou_user1" },
    ...overrides,
  };
}

describe("Feishu reaction lifecycle", () => {
  it("builds a created synthetic interaction payload", async () => {
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event: makeReactionEvent(),
      reactionActionType: "created",
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group_1",
        chatType: "group",
        senderOpenId: "ou_bot",
        senderType: "app",
        content: "hello",
        contentType: "text",
      }),
      uuid: () => "fixed-uuid",
    });

    expect(result?.message.content).toBe('{"text":"[reacted with THUMBSUP to message om_msg1]"}');
  });

  it("builds a deleted synthetic interaction payload", async () => {
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event: makeReactionEvent(),
      reactionActionType: "deleted",
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group_1",
        chatType: "group",
        senderOpenId: "ou_bot",
        senderType: "app",
        content: "hello",
        contentType: "text",
      }),
      uuid: () => "fixed-uuid",
    });

    expect(result?.message.content).toBe(
      '{"text":"[removed reaction THUMBSUP from message om_msg1]"}',
    );
  });
});
