/**
 * Unit tests for InMemoryTtlDb: set/get/has/delete, TTL expiry, and maxKeys eviction.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTtlDb } from "./ttl-db.js";

void test("InMemoryTtlDb basic set/get/has/delete", () => {
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

void test("InMemoryTtlDb auto-expiry cleanup", async () => {
  const db = new InMemoryTtlDb<string, string>({ ttlMs: 30, cleanupMinIntervalMs: 0 });

  db.set("key1", "value1");
  assert.equal(db.get("key1"), "value1");

  // Wait for expiry
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(db.get("key1"), null);
  assert.equal(db.has("key1"), false);
});

void test("InMemoryTtlDb maxKeys overflow eviction", () => {
  const db = new InMemoryTtlDb<string, number>({
    ttlMs: 60_000,
    maxKeys: 3,
    cleanupMinIntervalMs: 0,
  });

  db.set("a", 1);
  db.set("b", 2);
  db.set("c", 3);
  assert.equal(db.size(), 3);

  // Inserting the 4th entry should evict the earliest-expiring one
  db.set("d", 4);
  assert.equal(db.size(), 3);
  assert.equal(db.has("d"), true);
});

void test("InMemoryTtlDb returns null for non-existent key", () => {
  const db = new InMemoryTtlDb<string, string>({ ttlMs: 60_000, cleanupMinIntervalMs: 0 });

  assert.equal(db.get("nonexistent"), null);
  assert.equal(db.has("nonexistent"), false);
  assert.equal(db.delete("nonexistent"), false);
});

void test("InMemoryTtlDb set overwrites existing key", () => {
  const db = new InMemoryTtlDb<string, string>({ ttlMs: 60_000, cleanupMinIntervalMs: 0 });

  db.set("key", "old");
  assert.equal(db.get("key"), "old");

  db.set("key", "new");
  assert.equal(db.get("key"), "new");
  assert.equal(db.size(), 1);
});
