/**
 * messaging/chat-history.ts 单元测试
 *
 * 测试范围：recordMediaHistory、chatMediaHistories LRU 淘汰
 */

import assert from "node:assert/strict";
import test from "node:test";
import { recordMediaHistory, chatMediaHistories } from "./chat-history.js";

void test("recordMediaHistory 写入媒体历史", () => {
  // 清理
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

  // 清理
  chatMediaHistories.clear();
});

void test("recordMediaHistory 空 medias 不写入", () => {
  chatMediaHistories.clear();

  recordMediaHistory("group-002", {
    sender: "user-1",
    timestamp: Date.now(),
    medias: [],
  });

  assert.equal(chatMediaHistories.has("group-002"), false);

  chatMediaHistories.clear();
});

void test("recordMediaHistory LRU 淘汰超过上限的条目", () => {
  chatMediaHistories.clear();

  // 写入 55 条（上限 50）
  for (let i = 0; i < 55; i++) {
    recordMediaHistory("group-lru", {
      sender: `user-${i}`,
      timestamp: Date.now(),
      medias: [{ url: `https://example.com/img-${i}.png` }],
    });
  }

  const list = chatMediaHistories.get("group-lru");
  assert.ok(list);
  assert.equal(list.length, 50, "应淘汰最旧的 5 条，保留 50 条");
  // 最旧的应该是 user-5（前 5 条被淘汰）
  assert.equal(list[0].sender, "user-5");

  chatMediaHistories.clear();
});
