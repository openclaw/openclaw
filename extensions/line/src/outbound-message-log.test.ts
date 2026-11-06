// Line tests cover the record of message ids an inbound quote can point at.
import { describe, expect, it } from "vitest";
import {
  quotesLineBotMessage,
  recordLineSentMessages,
  rememberLineBotUserId,
} from "./outbound-message-log.js";

// `botUserId` is the webhook destination that received the quote.
const quotes = (accountId: string, quotedMessageId?: string, botUserId?: string) =>
  quotesLineBotMessage({ accountId, botUserId, quotedMessageId });
const ids = (prefix: string, length: number) =>
  Array.from({ length }, (_, index) => `${prefix}-${index}`);

describe("outbound message log", () => {
  it("recognizes only ids the same account sent", async () => {
    await recordLineSentMessages("work", ["sent-1", "sent-2"]);

    expect(await quotes("work", "sent-1")).toBe(true);
    expect(await quotes("work", "sent-2")).toBe(true);
    expect(await quotes("work", "never-sent")).toBe(false);
    expect(await quotes("work", undefined)).toBe(false);
    // Accounts stay apart so one bot's message never addresses another.
    expect(await quotes("personal", "sent-1")).toBe(false);
  });

  it("keeps a quiet account's ids while a busy account fills its own bound", async () => {
    await recordLineSentMessages("quiet", ["quiet-1"]);
    await recordLineSentMessages("busy", ids("busy", 2000));

    expect(await quotes("quiet", "quiet-1")).toBe(true);
    expect(await quotes("busy", "busy-1999")).toBe(true);
    expect(await quotes("busy", "busy-0")).toBe(false);
  });

  it("re-sending an id moves it back out of eviction range", async () => {
    await recordLineSentMessages("refresh", ["kept", ...ids("filler", 499), "kept"]);
    await recordLineSentMessages("refresh", ids("later", 400));

    expect(await quotes("refresh", "kept")).toBe(true);
  });

  it("forgets an account's remembered ids once it speaks for another bot", async () => {
    rememberLineBotUserId("repointed", "U-bot-a");
    await recordLineSentMessages("repointed", ["sent-by-bot-a"]);
    rememberLineBotUserId("repointed", "U-bot-a");
    expect(await quotes("repointed", "sent-by-bot-a", "U-bot-a")).toBe(true);

    rememberLineBotUserId("repointed", "U-bot-c");
    expect(await quotes("repointed", "sent-by-bot-a", "U-bot-c")).toBe(false);
  });

  it("ignores a quote delivered to a bot the account no longer speaks for", async () => {
    rememberLineBotUserId("handover", "U-bot-b");
    await recordLineSentMessages("handover", ["sent-by-bot-b"]);

    expect(await quotes("handover", "sent-by-bot-b", "U-bot-a")).toBe(false);
    expect(await quotes("handover", "sent-by-bot-b", "U-bot-b")).toBe(true);
  });
});
