import { describe, expect, it } from "vitest";
import { resolvePromptContextTextDedupeKey } from "./prompt-context-dedupe.js";

describe("resolvePromptContextTextDedupeKey", () => {
  it("matches assistant transcript text to Telegram cache text after stripping directive tags", () => {
    expect(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_760_000,
        body: "[[reply_to_current]]Yep - I'm here now.",
      }),
    ).toBe(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_760_000,
        body: "Yep - I'm here now.",
      }),
    );
  });

  it("matches inline directive text to Telegram delivery-normalized cache text", () => {
    expect(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_760_000,
        body: "hello [[reply_to_current]] world",
      }),
    ).toBe(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_760_000,
        body: "hello world",
      }),
    );
  });

  it("keeps timestamp alignment in the dedupe key", () => {
    expect(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_760_000,
        body: "[[reply_to_current]]Yep - I'm here now.",
      }),
    ).not.toBe(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_761_000,
        body: "Yep - I'm here now.",
      }),
    );
  });
});
