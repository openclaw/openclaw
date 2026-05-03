import type { Message } from "@grammyjs/types";

type ReplyTo = NonNullable<Message["reply_to_message"]>;
import { describe, expect, it } from "vitest";
import { detectTelegramBotTargeting } from "./body-helpers.js";

type PartialMessage = Pick<
  Message,
  "text" | "caption" | "entities" | "caption_entities" | "reply_to_message"
>;

function msg(partial: Partial<PartialMessage>): PartialMessage {
  return partial as PartialMessage;
}

describe("detectTelegramBotTargeting", () => {
  it("returns no fields when no bots are known and no reply target exists", () => {
    const result = detectTelegramBotTargeting(msg({ text: "hello world" }), {});
    expect(result).toEqual({});
  });

  it("detects mention of the current bot via entities", () => {
    const text = "hey @mybot please help";
    const result = detectTelegramBotTargeting(
      msg({
        text,
        entities: [{ type: "mention", offset: text.indexOf("@mybot"), length: 6 }],
      }),
      { currentBotUsername: "mybot" },
    );
    expect(result.mentionedBot).toBe("mybot");
  });

  it("detects mention via plain-text fallback when entities are missing", () => {
    const result = detectTelegramBotTargeting(msg({ text: "ping @mybot are you there?" }), {
      currentBotUsername: "mybot",
    });
    expect(result.mentionedBot).toBe("mybot");
  });

  it("detects mention of a sibling bot from otherBotUsernames", () => {
    const text = "asking @helperbot instead";
    const result = detectTelegramBotTargeting(
      msg({
        text,
        entities: [{ type: "mention", offset: text.indexOf("@helperbot"), length: 10 }],
      }),
      { currentBotUsername: "mybot", otherBotUsernames: ["helperbot", "anotherbot"] },
    );
    expect(result.mentionedBot).toBe("helperbot");
  });

  it("returns mentionedBot=null when known bots exist but none were mentioned", () => {
    const result = detectTelegramBotTargeting(msg({ text: "just a plain human message" }), {
      currentBotUsername: "mybot",
      otherBotUsernames: ["helperbot"],
    });
    expect(result.mentionedBot).toBeNull();
  });

  it("leaves mentionedBot undefined when no bot usernames are known", () => {
    const text = "hi @someone";
    const result = detectTelegramBotTargeting(
      msg({
        text,
        entities: [{ type: "mention", offset: 3, length: 8 }],
      }),
      {},
    );
    expect(result.mentionedBot).toBeUndefined();
  });

  it("derives repliedToBot from reply_to_message.from when the author is a bot", () => {
    const result = detectTelegramBotTargeting(
      msg({
        text: "yes please",
        reply_to_message: {
          message_id: 42,
          date: 1,
          chat: { id: 1, type: "supergroup", title: "x" },
          from: { id: 99, is_bot: true, first_name: "Helper", username: "HelperBot" },
        } as ReplyTo,
      }),
      {},
    );
    expect(result.repliedToBot).toBe("helperbot");
  });

  it("returns repliedToBot=null when reply target is a human", () => {
    const result = detectTelegramBotTargeting(
      msg({
        text: "ok",
        reply_to_message: {
          message_id: 7,
          date: 1,
          chat: { id: 1, type: "supergroup", title: "x" },
          from: { id: 1, is_bot: false, first_name: "Alice", username: "alice" },
        } as ReplyTo,
      }),
      {},
    );
    expect(result.repliedToBot).toBeNull();
  });

  it("leaves repliedToBot undefined when there's no reply target", () => {
    const result = detectTelegramBotTargeting(msg({ text: "hi" }), {});
    expect(result.repliedToBot).toBeUndefined();
  });

  it("populates both fields independently in a single pass", () => {
    const text = "@mybot did otherbot just say that?";
    const result = detectTelegramBotTargeting(
      msg({
        text,
        entities: [{ type: "mention", offset: 0, length: 6 }],
        reply_to_message: {
          message_id: 5,
          date: 1,
          chat: { id: 1, type: "supergroup", title: "x" },
          from: { id: 200, is_bot: true, first_name: "Sib", username: "OtherBot" },
        } as ReplyTo,
      }),
      { currentBotUsername: "mybot", otherBotUsernames: ["otherbot"] },
    );
    expect(result.mentionedBot).toBe("mybot");
    expect(result.repliedToBot).toBe("otherbot");
  });

  it("leaves mentionedBot undefined for media-only messages with no text/caption", () => {
    // Sticker / voice / non-captioned media: bots can only be mentioned via
    // text, so we never scan and therefore can't claim emptiness with null.
    const result = detectTelegramBotTargeting(msg({}), { currentBotUsername: "mybot" });
    expect(result.mentionedBot).toBeUndefined();
  });

  it("returns repliedToBot=null when reply target has no from (channel post / anonymous admin)", () => {
    // reply_to_message exists but reply.from is undefined — happens for
    // replies to channel posts and to anonymous group admins. We know there's
    // a reply target and it isn't a known bot, which is null (distinct from
    // undefined = "no reply target at all").
    const result = detectTelegramBotTargeting(
      msg({
        text: "ack",
        reply_to_message: {
          message_id: 11,
          date: 1,
          chat: { id: 1, type: "supergroup", title: "x" },
        } as ReplyTo,
      }),
      {},
    );
    expect(result.repliedToBot).toBeNull();
  });
});
