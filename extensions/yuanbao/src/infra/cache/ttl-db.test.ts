/**
 * utils/ttl-db.ts 单元测试
 *
 * 测试范围：InMemoryTtlDb 的 set/get/has/delete、过期清除、maxKeys 溢出淘汰
 */

import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTtlDb } from "./ttl-db.js";

void test("InMemoryTtlDb 基本 set/get/has/delete", () => {
  const db = new InMemoryTtlDb<string, string>({ ttlMs: 60_000, cleanupMinIntervalMs: 0 });

  db.set("key1", "value1");
  assert.equal(db.has("key1"), true);
  assert.equal(db.get("key1"), "value1");
  assert.equal(db.size(), 1);

  assert.equal(db.delete("key1"), true);
  assert.equal(db.has("key1"), false);
  assert.equal(db.get("key1"), null);
  assert.equal(db.size(), 0);
});

void test("InMemoryTtlDb 过期自动清除", async () => {
  const db = new InMemoryTtlDb<string, string>({ ttlMs: 30, cleanupMinIntervalMs: 0 });

  db.set("key1", "value1");
  assert.equal(db.get("key1"), "value1");

  // 等待过期
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(db.get("key1"), null);
  assert.equal(db.has("key1"), false);
});

void test("InMemoryTtlDb maxKeys 溢出淘汰", () => {
  const db = new InMemoryTtlDb<string, number>({
    ttlMs: 60_000,
    maxKeys: 3,
    cleanupMinIntervalMs: 0,
  });

  db.set("a", 1);
  db.set("b", 2);
  db.set("c", 3);
  assert.equal(db.size(), 3);

  // 插入第 4 个，应淘汰最早过期的
  db.set("d", 4);
  assert.equal(db.size(), 3);
  assert.equal(db.has("d"), true);
});

void test("InMemoryTtlDb 不存在的 key 返回 null", () => {
  const db = new InMemoryTtlDb<string, string>({ ttlMs: 60_000, cleanupMinIntervalMs: 0 });

  assert.equal(db.get("nonexistent"), null);
  assert.equal(db.has("nonexistent"), false);
  assert.equal(db.delete("nonexistent"), false);
});

void test("InMemoryTtlDb set 覆盖已有 key", () => {
  const db = new InMemoryTtlDb<string, string>({ ttlMs: 60_000, cleanupMinIntervalMs: 0 });

  db.set("key", "old");
  assert.equal(db.get("key"), "old");

  db.set("key", "new");
  assert.equal(db.get("key"), "new");
  assert.equal(db.size(), 1);
});
