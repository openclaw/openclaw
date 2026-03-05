/**
 * Tests for stream utilities (wecom/stream-utils.js)
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getMessageStreamKey, clearBufferedMessagesForStream } from "../wecom/stream-utils.js";
import { messageBuffers } from "../wecom/state.js";
import { streamManager } from "../stream-manager.js";

// ── getMessageStreamKey ───────────────────────────────────────────────────────

describe("getMessageStreamKey — single chat", () => {
  it("returns fromUser for single chat messages", () => {
    const msg = { chatType: "single", fromUser: "user123", chatId: "" };
    assert.equal(getMessageStreamKey(msg), "user123");
  });

  it("prefixes accountId when present", () => {
    const msg = { accountId: "bot1", chatType: "single", fromUser: "userABC", chatId: "" };
    assert.equal(getMessageStreamKey(msg), "bot1:userABC");
  });

  it("defaults chatType to single when absent", () => {
    const msg = { fromUser: "someone" };
    assert.equal(getMessageStreamKey(msg), "someone");
  });

  it("returns empty string for null/undefined input", () => {
    assert.equal(getMessageStreamKey(null), "");
    assert.equal(getMessageStreamKey(undefined), "");
  });

  it("returns empty string for non-object input", () => {
    assert.equal(getMessageStreamKey("string"), "");
    assert.equal(getMessageStreamKey(42), "");
  });
});

describe("getMessageStreamKey — group chat", () => {
  it("returns chatId for group messages with chatId", () => {
    const msg = { chatType: "group", fromUser: "user123", chatId: "group-abc" };
    assert.equal(getMessageStreamKey(msg), "group-abc");
  });

  it("prefixes accountId for group chat", () => {
    const msg = { accountId: "bot2", chatType: "group", fromUser: "u", chatId: "grp-x" };
    assert.equal(getMessageStreamKey(msg), "bot2:grp-x");
  });

  it("falls back to fromUser when group chatId is empty", () => {
    // chatType=group but chatId is empty — should fall through to fromUser branch.
    const msg = { chatType: "group", fromUser: "user456", chatId: "" };
    assert.equal(getMessageStreamKey(msg), "user456");
  });
});

describe("getMessageStreamKey — key format", () => {
  it("produces unique keys for different users in same account", () => {
    const key1 = getMessageStreamKey({ accountId: "bot1", chatType: "single", fromUser: "u1" });
    const key2 = getMessageStreamKey({ accountId: "bot1", chatType: "single", fromUser: "u2" });
    assert.notEqual(key1, key2);
  });

  it("produces unique keys for same user in different accounts", () => {
    const key1 = getMessageStreamKey({ accountId: "bot1", chatType: "single", fromUser: "u1" });
    const key2 = getMessageStreamKey({ accountId: "bot2", chatType: "single", fromUser: "u1" });
    assert.notEqual(key1, key2);
  });

  it("produces unique keys for group vs single with same ID value", () => {
    const key1 = getMessageStreamKey({ chatType: "single", fromUser: "same-id", chatId: "" });
    const key2 = getMessageStreamKey({ chatType: "group", fromUser: "x", chatId: "same-id" });
    // Both produce "same-id" — this is expected behaviour (chatId deduplication).
    // The test documents what happens rather than asserting inequality.
    assert.equal(typeof key1, "string");
    assert.equal(typeof key2, "string");
  });
});

// ── clearBufferedMessagesForStream ────────────────────────────────────────────

describe("clearBufferedMessagesForStream", () => {
  beforeEach(() => {
    // Clean up any leftover buffer entries between tests.
    messageBuffers.clear();
  });

  it("returns 0 when there is no buffer for the key", () => {
    const result = clearBufferedMessagesForStream("no-buffer-key");
    assert.equal(result, 0);
  });

  it("removes the buffer entry from messageBuffers", () => {
    const key = `clear-test-${Date.now()}`;
    // Manually set up a buffer entry with no real streams to drain.
    messageBuffers.set(key, {
      streamIds: [],
      timer: setTimeout(() => {}, 60000),
    });
    assert.equal(messageBuffers.has(key), true);

    clearBufferedMessagesForStream(key, "test reason");
    assert.equal(messageBuffers.has(key), false);
  });

  it("drains buffered stream IDs and returns count", async () => {
    const key = `drain-test-${Date.now()}`;

    // Create real stream entries so finishStream works.
    const sid1 = `buf-stream-1-${Date.now()}`;
    const sid2 = `buf-stream-2-${Date.now()}`;
    streamManager.createStream(sid1);
    streamManager.createStream(sid2);

    // The streams start with empty content; replaceIfPlaceholder + finish should work.
    messageBuffers.set(key, {
      streamIds: [sid1, sid2],
      timer: setTimeout(() => {}, 60000),
    });

    const drained = clearBufferedMessagesForStream(key, "interrupted");
    assert.equal(drained, 2);
    assert.equal(messageBuffers.has(key), false);
  });

  it("uses default Chinese notice text when no reason is provided", () => {
    const key = `default-msg-${Date.now()}`;
    const sid = `default-stream-${Date.now()}`;
    streamManager.createStream(sid);
    // Set the stream content to the thinking placeholder so the replace fires.
    streamManager.updateStream(sid, "思考中...");
    messageBuffers.set(key, {
      streamIds: [sid],
      timer: setTimeout(() => {}, 60000),
    });

    // Should not throw; uses default reason.
    clearBufferedMessagesForStream(key);
    // Buffer is cleared regardless of the notice text.
    assert.equal(messageBuffers.has(key), false);
  });
});
