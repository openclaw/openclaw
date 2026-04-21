/**
 * Unit tests for chat-history.ts: recordMediaHistory and chatMediaHistories LRU eviction.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { recordMediaHistory, chatMediaHistories } from "./chat-history.js";

void test("recordMediaHistory writes media history", () => {
  // Clear
  chatMediaHistories.clear();

  recordMediaHistory("group-001", {
    sender: "user-1",
    timestamp: Date.now(),
    medias: [{ url: "https://example.com/img.png" }],
  });

  const list = chatMediaHistories.get("group-001");
  assert.ok(list);
  assert.equal(list.length, 1);
  assert.equal(list[0].sender, "user-1");

  // Clear
  chatMediaHistories.clear();
});

void test("recordMediaHistory skips empty medias", () => {
  chatMediaHistories.clear();

  recordMediaHistory("group-002", {
    sender: "user-1",
    timestamp: Date.now(),
    medias: [],
  });

  assert.equal(chatMediaHistories.has("group-002"), false);

  chatMediaHistories.clear();
});

void test("recordMediaHistory LRU evicts entries exceeding limit", () => {
  chatMediaHistories.clear();

  // Write 55 entries (limit is 50)
  for (let i = 0; i < 55; i++) {
    recordMediaHistory("group-lru", {
      sender: `user-${i}`,
      timestamp: Date.now(),
      medias: [{ url: `https://example.com/img-${i}.png` }],
    });
  }

  const list = chatMediaHistories.get("group-lru");
  assert.ok(list);
  assert.equal(list.length, 50, "should evict oldest 5 entries, keeping 50");
  // Oldest should be user-5 (first 5 evicted)
  assert.equal(list[0].sender, "user-5");

  chatMediaHistories.clear();
});
