// Tests that prompt-context text dedupe keys handle directive-tag
// differences and timestamp drift between session transcript rows and
// Telegram cache rows (#99117 / #99546).
import { describe, expect, it } from "vitest";
import { resolvePromptContextTextDedupeKey } from "./bot-handlers.runtime.js";

function row(
  body: string,
  timestampMs: number,
  role: "assistant" | "user" = "assistant",
  sender?: string,
) {
  return { body, timestamp_ms: timestampMs, role, sender };
}

describe("resolvePromptContextTextDedupeKey", () => {
  it("dedupes bot rows when only difference is directive tags (same timestamp)", () => {
    const sessionRow = row("[[reply_to_current]]Hello, world!", 1_778_474_760_000);
    const cacheRow = row("Hello, world!", 1_778_474_760_000);

    expect(resolvePromptContextTextDedupeKey(sessionRow)).toBe(
      resolvePromptContextTextDedupeKey(cacheRow),
    );
  });

  it("dedupes bot rows with timestamp drift (6s apart)", () => {
    const sessionRow = row("[[reply_to_current]]Duplicate context row", 1_778_474_760_000);
    const cacheRow = row("Duplicate context row", 1_778_474_766_000);

    expect(resolvePromptContextTextDedupeKey(sessionRow)).toBe(
      resolvePromptContextTextDedupeKey(cacheRow),
    );
  });

  it("dedupes bot rows with different sender display names but same role", () => {
    // Session says "OpenClaw", cache says "MyBot" — both assistant.
    const sessionRow = row("status update", 1_700_000_000_000, "assistant", "OpenClaw");
    const cacheRow = row("status update", 1_700_000_000_500, "assistant", "MyBot");

    expect(resolvePromptContextTextDedupeKey(sessionRow)).toBe(
      resolvePromptContextTextDedupeKey(cacheRow),
    );
  });

  it("does not dedupe user rows with same text at different timestamps", () => {
    const msg1 = row("hello", 1_778_474_760_000, "user", "User");
    const msg2 = row("hello", 1_778_474_820_000, "user", "User");

    const key1 = resolvePromptContextTextDedupeKey(msg1);
    const key2 = resolvePromptContextTextDedupeKey(msg2);

    expect(key1).not.toBe(key2);
    expect(key1).toContain("hello");
    expect(key2).toContain("hello");
  });

  it("does not cross-dedupe a user row and a bot row with same text", () => {
    // User says "ok" at 12:00:00, bot also replies "ok" at 12:00:05.
    // They must not be collapsed.
    const userRow = row("ok", 1_700_000_000_000, "user", "John Smith");
    const botRow = row("ok", 1_700_000_005_000, "assistant", "MyBot");

    const userKey = resolvePromptContextTextDedupeKey(userRow);
    const botKey = resolvePromptContextTextDedupeKey(botRow);

    expect(userKey).not.toBe(botKey);
    // User key has timestamp, bot key does not.
    expect(userKey).toBe("1700000000000:ok");
    expect(botKey).toBe("ok");
  });

  it("returns undefined for empty body", () => {
    expect(resolvePromptContextTextDedupeKey(row("  ", 1_700_000_000_000))).toBe(undefined);
  });

  it("returns undefined for non-finite timestamp", () => {
    expect(resolvePromptContextTextDedupeKey(row("hello", Number.NaN))).toBeUndefined();
  });
});
