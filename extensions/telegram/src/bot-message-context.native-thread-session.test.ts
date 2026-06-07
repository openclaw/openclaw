import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext native reply thread sessions", () => {
  it("seeds a top-level forum topic message into a root-message session", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 101,
        chat: { id: -100200300, type: "supergroup", is_forum: true },
        message_thread_id: 77,
        text: "@bot prepare a marketing brief",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx?.ctxPayload.SessionKey).toContain(":thread:topic:77:message:101");
  });

  it("routes replies in the same forum topic back to the original root message session", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 202,
        chat: { id: -100200300, type: "supergroup", is_forum: true },
        message_thread_id: 77,
        text: "Any update?",
        reply_to_message: {
          message_id: 150,
          chat: { id: -100200300, type: "supergroup", is_forum: true },
          message_thread_id: 77,
          text: "Working on it",
          from: { id: 7, first_name: "Bot", is_bot: true },
        },
      },
      replyChain: [
        {
          messageId: "150",
          sender: "Bot",
          body: "Working on it",
          replyToId: "101",
        },
        {
          messageId: "101",
          sender: "Alice",
          body: "@bot prepare a marketing brief",
        },
      ],
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx?.ctxPayload.SessionKey).toContain(":thread:topic:77:message:101");
    expect(ctx?.ctxPayload.SessionKey).not.toContain(":message:150");
    expect(ctx?.ctxPayload.SessionKey).not.toContain(":message:202");
  });

  it("does not collapse top-level forum topic messages onto the topic-created system message", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 303,
        chat: { id: -100200300, type: "supergroup", is_forum: true },
        message_thread_id: 77,
        text: "@bot new request",
        reply_to_message: {
          message_id: 1,
          chat: { id: -100200300, type: "supergroup", is_forum: true },
          message_thread_id: 77,
          forum_topic_created: { name: "Chief of Staff", icon_color: 7322096 },
        },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx?.ctxPayload.SessionKey).toContain(":thread:topic:77:message:303");
    expect(ctx?.ctxPayload.SessionKey).not.toContain(":message:1");
  });
});
