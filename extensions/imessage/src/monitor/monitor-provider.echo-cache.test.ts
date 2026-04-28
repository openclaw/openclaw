import { afterEach, describe, expect, it, vi } from "vitest";
import { createSentMessageCache } from "./echo-cache.js";

describe("iMessage sent-message echo cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches recent text within the same scope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "  Reasoning:\r\n_step_  " });

    expect(cache.has("acct:imessage:+1555", { text: "Reasoning:\n_step_" })).toBe(true);
    expect(cache.has("acct:imessage:+1666", { text: "Reasoning:\n_step_" })).toBe(false);
  });

  it("strips leading imsg corruption bytes from text keys", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "\ufffd\u0000Reasoning:\n\t_step_" });

    expect(cache.has("acct:imessage:+1555", { text: "Reasoning:\n\t_step_" })).toBe(true);
  });

  it("preserves interior control characters in text keys", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "alpha\u0007beta\n\tgamma" });

    expect(cache.has("acct:imessage:+1555", { text: "alpha\u0007beta\n\tgamma" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { text: "alphabeta\n\tgamma" })).toBe(false);
  });

  it("matches by outbound message id and ignores placeholder ids", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { messageId: "abc-123" });
    cache.remember("acct:imessage:+1555", { messageId: "ok" });

    expect(cache.has("acct:imessage:+1555", { messageId: "abc-123" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { messageId: "ok" })).toBe(false);
  });

  it("keeps message-id lookups longer than text fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "hello", messageId: "m-1" });
    // Text fallback stays short to avoid suppressing legitimate repeated user text.
    vi.advanceTimersByTime(6_000);

    expect(cache.has("acct:imessage:+1555", { text: "hello" })).toBe(false);
    expect(cache.has("acct:imessage:+1555", { messageId: "m-1" })).toBe(true);
  });
});
