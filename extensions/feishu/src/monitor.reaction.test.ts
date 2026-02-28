import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { resolveReactionSyntheticEvent, type FeishuReactionCreatedEvent } from "./monitor.js";

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

describe("resolveReactionSyntheticEvent", () => {
  it("filters app self-reactions", async () => {
    const event = makeReactionEvent({ operator_type: "app" });
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
    });
    expect(result).toBeNull();
  });

  it("filters Typing reactions", async () => {
    const event = makeReactionEvent({ reaction_type: { emoji_type: "Typing" } });
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
    });
    expect(result).toBeNull();
  });

  it("fails closed when bot open_id is unavailable", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
    });
    expect(result).toBeNull();
  });

  it("filters reactions on non-bot messages", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group",
        senderOpenId: "ou_other",
        senderType: "user",
        content: "hello",
        contentType: "text",
      }),
    });
    expect(result).toBeNull();
  });

  it("drops unverified reactions when sender verification times out", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      verificationTimeoutMs: 1,
      fetchMessage: async () =>
        await new Promise<never>(() => {
          // Never resolves
        }),
    });
    expect(result).toBeNull();
  });

  it("uses event chat context when provided", async () => {
    const event = makeReactionEvent({
      chat_id: "oc_group_from_event",
      chat_type: "group",
    });
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group_from_lookup",
        senderOpenId: "ou_bot",
        content: "hello",
        contentType: "text",
      }),
      uuid: () => "fixed-uuid",
    });

    expect(result).toEqual({
      sender: {
        sender_id: { open_id: "ou_user1" },
        sender_type: "user",
      },
      message: {
        message_id: "om_msg1:reaction:THUMBSUP:fixed-uuid",
        chat_id: "oc_group_from_event",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: "[reacted with THUMBSUP to message om_msg1]",
        }),
      },
    });
  });

  it("falls back to reacted message chat_id when event chat_id is absent", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group_from_lookup",
        senderOpenId: "ou_bot",
        content: "hello",
        contentType: "text",
      }),
      uuid: () => "fixed-uuid",
    });

    expect(result?.message.chat_id).toBe("oc_group_from_lookup");
    expect(result?.message.chat_type).toBe("p2p");
  });

  it("falls back to sender p2p chat when lookup returns empty chat_id", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "",
        senderOpenId: "ou_bot",
        content: "hello",
        contentType: "text",
      }),
      uuid: () => "fixed-uuid",
    });

    expect(result?.message.chat_id).toBe("p2p:ou_user1");
    expect(result?.message.chat_type).toBe("p2p");
  });

  it("logs and drops reactions when lookup throws", async () => {
    const log = vi.fn();
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "acct1",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => {
        throw new Error("boom");
      },
      logger: log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("ignoring reaction on non-bot/unverified message om_msg1"),
    );
  });
});
