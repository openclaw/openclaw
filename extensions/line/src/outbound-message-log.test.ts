// Line tests cover the record of message ids an inbound quote can point at.
import { describe, expect, it } from "vitest";
import {
  quotesLineBotMessage,
  recordLineSentMessages,
  rememberLineBotUserId,
} from "./outbound-message-log.js";

describe("outbound message log", () => {
  it("recognizes an id this account sent and nothing else", async () => {
    await recordLineSentMessages("default", ["sent-1", "sent-2"]);

    expect(
      await quotesLineBotMessage({
        accountId: "default",
        botUserId: undefined,
        quotedMessageId: "sent-1",
      }),
    ).toBe(true);
    expect(
      await quotesLineBotMessage({
        accountId: "default",
        botUserId: undefined,
        quotedMessageId: "sent-2",
      }),
    ).toBe(true);
    expect(
      await quotesLineBotMessage({
        accountId: "default",
        botUserId: undefined,
        quotedMessageId: "never-sent",
      }),
    ).toBe(false);
    expect(
      await quotesLineBotMessage({
        accountId: "default",
        botUserId: undefined,
        quotedMessageId: undefined,
      }),
    ).toBe(false);
  });

  it("keeps accounts apart so one bot's message never addresses another", async () => {
    await recordLineSentMessages("work", ["shared-room-message"]);

    expect(
      await quotesLineBotMessage({
        accountId: "work",
        botUserId: undefined,
        quotedMessageId: "shared-room-message",
      }),
    ).toBe(true);
    expect(
      await quotesLineBotMessage({
        accountId: "personal",
        botUserId: undefined,
        quotedMessageId: "shared-room-message",
      }),
    ).toBe(false);
  });

  it("keeps a quiet account's ids while a busy account fills its own bound", async () => {
    await recordLineSentMessages("quiet", ["quiet-1"]);
    await recordLineSentMessages(
      "busy",
      Array.from({ length: 2000 }, (_, index) => `busy-${index}`),
    );

    expect(
      await quotesLineBotMessage({
        accountId: "quiet",
        botUserId: undefined,
        quotedMessageId: "quiet-1",
      }),
    ).toBe(true);
    expect(
      await quotesLineBotMessage({
        accountId: "busy",
        botUserId: undefined,
        quotedMessageId: "busy-1999",
      }),
    ).toBe(true);
    expect(
      await quotesLineBotMessage({
        accountId: "busy",
        botUserId: undefined,
        quotedMessageId: "busy-0",
      }),
    ).toBe(false);
  });

  it("re-sending an id moves it back out of eviction range", async () => {
    await recordLineSentMessages("refresh", ["kept"]);
    await recordLineSentMessages(
      "refresh",
      Array.from({ length: 499 }, (_, i) => `filler-${i}`),
    );
    await recordLineSentMessages("refresh", ["kept"]);
    await recordLineSentMessages(
      "refresh",
      Array.from({ length: 400 }, (_, i) => `later-${i}`),
    );

    expect(
      await quotesLineBotMessage({
        accountId: "refresh",
        botUserId: undefined,
        quotedMessageId: "kept",
      }),
    ).toBe(true);
  });

  it("forgets an account's remembered ids once it speaks for another bot", async () => {
    rememberLineBotUserId("repointed", "U-bot-a");
    await recordLineSentMessages("repointed", ["sent-by-bot-a"]);
    rememberLineBotUserId("repointed", "U-bot-a");

    expect(
      await quotesLineBotMessage({
        accountId: "repointed",
        botUserId: "U-bot-a",
        quotedMessageId: "sent-by-bot-a",
      }),
    ).toBe(true);

    rememberLineBotUserId("repointed", "U-bot-c");

    expect(
      await quotesLineBotMessage({
        accountId: "repointed",
        botUserId: "U-bot-c",
        quotedMessageId: "sent-by-bot-a",
      }),
    ).toBe(false);
  });

  it("ignores a quote delivered to a bot the account no longer speaks for", async () => {
    rememberLineBotUserId("handover", "U-bot-b");
    await recordLineSentMessages("handover", ["sent-by-bot-b"]);

    expect(
      await quotesLineBotMessage({
        accountId: "handover",
        botUserId: "U-bot-a",
        quotedMessageId: "sent-by-bot-b",
      }),
    ).toBe(false);
    expect(
      await quotesLineBotMessage({
        accountId: "handover",
        botUserId: "U-bot-b",
        quotedMessageId: "sent-by-bot-b",
      }),
    ).toBe(true);
  });
});
