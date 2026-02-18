import { describe, expect, it } from "vitest";
import { createSentMessageCache } from "./echo-cache.js";

describe("iMessage sent-message echo cache", () => {
  it("matches recent text within the same scope", () => {
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "  Reasoning:\r\n_step_  " });

    expect(cache.has("acct:imessage:+1555", { text: "Reasoning:\n_step_" })).toBe(true);
    expect(cache.has("acct:imessage:+1666", { text: "Reasoning:\n_step_" })).toBe(false);
  });

  it("matches by outbound message id and ignores placeholder ids", () => {
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { messageId: "abc-123" });
    cache.remember("acct:imessage:+1555", { messageId: "ok" });

    expect(cache.has("acct:imessage:+1555", { messageId: "abc-123" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { messageId: "ok" })).toBe(false);
  });

  it("matches both text and messageId when stored together", () => {
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "hello", messageId: "m-1" });

    expect(cache.has("acct:imessage:+1555", { text: "hello" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { messageId: "m-1" })).toBe(true);
  });

  it("one-shot text match so same user text later is not treated as echo", () => {
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "ok user" });
    expect(cache.has("acct:imessage:+1555", { text: "ok user" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { text: "ok user" })).toBe(false);
  });
});
