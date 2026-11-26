// Slack tests cover message subtype handlers plugin behavior.
import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackBotSubtypeAdmission } from "./message-subtype-admission.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";

describe("resolveSlackMessageSubtypeHandler", () => {
  it("resolves message_changed metadata and identifiers", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "D1",
      event_ts: "123.456",
      message: { ts: "123.456", user: "U1" },
      previous_message: { ts: "123.450", user: "U2" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.eventKind).toBe("message_changed");
    expect(handler?.senderId).toBe("U1");
    expect(handler?.contextKey).toBe("slack:message:changed:D1:123.456");
    expect(handler?.describe("DM with @user")).toContain("edited");
    expect(handler?.botAuthored).toBe(false);
    expect(handler?.text).toBeUndefined();
  });

  it("detects a bot-authored edit and exposes the edited text", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      event_ts: "123.456",
      message: {
        ts: "123.456",
        thread_ts: "123.000",
        bot_id: "B1",
        text: "edited <@U_BOT> text",
      },
      previous_message: { ts: "123.456", bot_id: "B1", text: "old text" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.eventKind).toBe("message_changed");
    expect(handler?.senderId).toBe("B1");
    expect(handler?.botAuthored).toBe(true);
    expect(handler?.text).toBe("edited <@U_BOT> text");
  });

  it("reads the new text of a top-level edit instead of the previous message", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      event_ts: "123.456",
      message: { ts: "123.456", bot_id: "B1", text: "now <@U_BOT>" },
      previous_message: { ts: "123.456", bot_id: "B1", text: "no mention" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.text).toBe("now <@U_BOT>");
  });

  it("reads a top-level edit that removes a mention as the new text", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      event_ts: "123.456",
      message: { ts: "123.456", bot_id: "B1", text: "no mention" },
      previous_message: { ts: "123.456", bot_id: "B1", text: "old <@U_BOT>" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.text).toBe("no mention");
  });

  it("treats a Slackbot tombstone as the deleted message", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      event_ts: "123.456",
      message: {
        ts: "123.000",
        thread_ts: "123.000",
        subtype: "tombstone",
        user: "USLACKBOT",
        text: "This message was deleted.",
      },
      previous_message: { ts: "123.000", bot_id: "B1", text: "card <@U_BOT>" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.eventKind).toBe("message_changed");
    expect(handler?.botAuthored).toBe(true);
    expect(handler?.text).toBe("card <@U_BOT>");
  });

  it("treats a bot_message subtype without bot_id as bot-authored", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      event_ts: "123.456",
      message: {
        ts: "123.456",
        thread_ts: "123.000",
        subtype: "bot_message",
        text: "bot text",
      },
      previous_message: { ts: "123.456", subtype: "bot_message", text: "old bot text" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.senderId).toBeUndefined();
    expect(handler?.botAuthored).toBe(true);
    expect(handler?.text).toBe("bot text");
  });

  it("resolves a bot-authored delete from previous_message", () => {
    const event = {
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      event_ts: "123.456",
      deleted_ts: "123.400",
      previous_message: { ts: "123.400", bot_id: "B1", text: "deleted bot text" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.eventKind).toBe("message_deleted");
    expect(handler?.senderId).toBe("B1");
    expect(handler?.botAuthored).toBe(true);
    expect(handler?.text).toBe("deleted bot text");
  });

  it("leaves human-authored deletes outside the bot gate", () => {
    const event = {
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      event_ts: "123.456",
      deleted_ts: "123.400",
      previous_message: { ts: "123.400", user: "U1", text: "human text" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.senderId).toBe("U1");
    expect(handler?.botAuthored).toBe(false);
    expect(handler?.text).toBe("human text");
  });
});

describe("resolveSlackBotSubtypeAdmission", () => {
  const bot = {
    botUserId: "U_BOT",
    text: "hello there",
  } as const;

  it.each([
    [false, "drop"],
    [true, "allow"],
    [undefined, "allow"],
  ] as const)("applies allowBots=%s to bot edits as %s", (allowBots, expected) => {
    expect(resolveSlackBotSubtypeAdmission({ ...bot, allowBots })).toBe(expected);
  });

  it.each([
    ["<@U_BOT> please look", "allow"],
    ["<@U_BOT|openclaw> please look", "allow"],
    ["<@u_bot> case-insensitive", "allow"],
    ["<@U_OTHER> not the agent", "drop"],
    ["no mention at all", "drop"],
    ["<!subteam^S123> subteam only", "drop"],
    ["", "drop"],
    [undefined, "drop"],
  ] as const)("applies allowBots=mentions to text %s as %s", (text, expected) => {
    expect(resolveSlackBotSubtypeAdmission({ ...bot, allowBots: "mentions", text })).toBe(expected);
  });

  it("drops mentions-mode bot edits when the bot user id is unknown", () => {
    expect(
      resolveSlackBotSubtypeAdmission({
        allowBots: "mentions",
        botUserId: undefined,
        text: "<@U_BOT> hello",
      }),
    ).toBe("drop");
  });

  it.each([
    ["without a mention", "no mention at all"],
    ["without any text", undefined],
  ] as const)("admits mentions-mode bot edits in DMs %s", (_label, text) => {
    expect(
      resolveSlackBotSubtypeAdmission({
        allowBots: "mentions",
        botUserId: "U_BOT",
        text,
        directMessage: true,
      }),
    ).toBe("allow");
  });

  it("still drops mentions-mode bot DMs when allowBots is false", () => {
    expect(
      resolveSlackBotSubtypeAdmission({
        allowBots: false,
        botUserId: "U_BOT",
        text: "<@U_BOT> hello",
        directMessage: true,
      }),
    ).toBe("drop");
  });
});
