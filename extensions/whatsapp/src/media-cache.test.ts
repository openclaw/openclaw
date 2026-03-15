import { describe, expect, it } from "vitest";
import { MediaCache } from "./media-cache.js";

describe("MediaCache", () => {
  describe("initialization", () => {
    it("creates cache with default config", () => {
      const cache = new MediaCache();
      const stats = cache.getStats();
      expect(stats.enabled).toBe(true);
      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(1000);
      expect(stats.ttlMs).toBe(24 * 60 * 60 * 1000); // 24 hours
    });

    it("creates cache with custom config", () => {
      const cache = new MediaCache({
        ttlMs: 60 * 1000,
        maxSize: 100,
        enabled: false,
      });
      const stats = cache.getStats();
      expect(stats.ttlMs).toBe(60 * 1000);
      expect(stats.maxSize).toBe(100);
      expect(stats.enabled).toBe(false);
    });

    it("enforces minimum maxSize of 1", () => {
      const cache = new MediaCache({ maxSize: 0 });
      expect(cache.getStats().maxSize).toBe(1);
    });
  });

  describe("key generation", () => {
    const cache = new MediaCache();

    it("generates message-id based keys", () => {
      const key = cache.generateKey("msg_12345", "message-id");
      expect(key).toBe("msg:msg_12345");
    });

    it("generates url-hash based keys", () => {
      const url = "https://example.com/media.jpg";
      const key = cache.generateKey(url, "url-hash");
      expect(key).toMatch(/^url:[a-f0-9]+$/);
      expect(key.length).toBeLessThan(40); // "url:" + 32 chars
    });

    it("generates consistent hash for same URL", () => {
      const url = "https://example.com/media.jpg";
      const key1 = cache.generateKey(url, "url-hash");
      const key2 = cache.generateKey(url, "url-hash");
      expect(key1).toBe(key2);
    });

    it("defaults to message-id strategy", () => {
      const key = cache.generateKey("msg_123");
      expect(key).toBe("msg:msg_123");
    });

    it("generates different keys for different URLs", () => {
      const key1 = cache.generateKey("https://example.com/a.jpg", "url-hash");
      const key2 = cache.generateKey("https://example.com/b.jpg", "url-hash");
      expect(key1).not.toBe(key2);
    });
  });

  describe("get/set operations", () => {
    it("stores and retrieves media data", () => {
      const cache = new MediaCache();
      const buffer = Buffer.from("test-data");
      const data = {
        buffer,
        mimetype: "image/jpeg",
        fileName: "test.jpg",
      };

      const key = cache.generateKey("msg_1");
      cache.set(key, data);
      const retrieved = cache.get(key);

      expect(retrieved).toBeDefined();
      expect(retrieved?.buffer).toEqual(buffer);
      expect(retrieved?.mimetype).toBe("image/jpeg");
      expect(retrieved?.fileName).toBe("test.jpg");
    });

    it("returns undefined for non-existent keys", () => {
      const cache = new MediaCache();
      const retrieved = cache.get("non-existent-key");
      expect(retrieved).toBeUndefined();
    });

    it("stores data with optional fields", () => {
      const cache = new MediaCache();
      const buffer = Buffer.from("test-data");
      const data = { buffer }; // Only required field

      const key = cache.generateKey("msg_2");
      cache.set(key, data);
      const retrieved = cache.get(key);

      expect(retrieved).toBeDefined();
      expect(retrieved?.buffer).toEqual(buffer);
      expect(retrieved?.mimetype).toBeUndefined();
      expect(retrieved?.fileName).toBeUndefined();
    });

    it("does not expose internal cachedAt timestamp", () => {
      const cache = new MediaCache();
      const buffer = Buffer.from("test-data");
      const key = cache.generateKey("msg_3");

      cache.set(key, { buffer });
      const retrieved = cache.get(key);

      expect(retrieved).not.toHaveProperty("cachedAt");
    });
  });

  describe("has method", () => {
    it("returns true for existing non-expired entries", () => {
      const cache = new MediaCache({ ttlMs: 10000 });
      const key = cache.generateKey("msg_4");
      const buffer = Buffer.from("test");

      cache.set(key, { buffer });
      expect(cache.has(key)).toBe(true);
    });

    it("returns false for non-existent keys", () => {
      const cache = new MediaCache();
      expect(cache.has("non-existent")).toBe(false);
    });

    it("returns false for expired entries and deletes them", async () => {
      const cache = new MediaCache({ ttlMs: 100 });
      const key = cache.generateKey("msg_5");
      const buffer = Buffer.from("test");

      cache.set(key, { buffer });
      expect(cache.has(key)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(cache.has(key)).toBe(false);
    });
  });

  describe("delete and clear", () => {
    it("deletes a specific entry", () => {
      const cache = new MediaCache();
      const key = cache.generateKey("msg_6");
      const buffer = Buffer.from("test");

      cache.set(key, { buffer });
      expect(cache.has(key)).toBe(true);

      cache.delete(key);
      expect(cache.has(key)).toBe(false);
    });

    it("clears all entries", () => {
      const cache = new MediaCache();
      const buffer = Buffer.from("test");

      cache.set(cache.generateKey("msg_7"), { buffer });
      cache.set(cache.generateKey("msg_8"), { buffer });
      cache.set(cache.generateKey("msg_9"), { buffer });

      expect(cache.getStats().size).toBe(3);

      cache.clear();
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("TTL and expiration", () => {
    it("returns undefined for expired entries on get", async () => {
      const cache = new MediaCache({ ttlMs: 100 });
      const key = cache.generateKey("msg_10");
      const buffer = Buffer.from("test");

      cache.set(key, { buffer });
      expect(cache.get(key)).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(cache.get(key)).toBeUndefined();
    });

    it("prunes expired entries when accessing cache", async () => {
      const cache = new MediaCache({ ttlMs: 100 });
      const key1 = cache.generateKey("msg_11");
      const key2 = cache.generateKey("msg_12");
      const buffer = Buffer.from("test");

      cache.set(key1, { buffer });
      cache.set(key2, { buffer });

      expect(cache.getStats().size).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Accessing cache triggers pruning
      cache.get(key1);
      expect(cache.getStats().size).toBe(0);
    });

    it("does not expire when ttlMs is 0 or negative", async () => {
      const cache = new MediaCache({ ttlMs: 0 });
      const key = cache.generateKey("msg_13");
      const buffer = Buffer.from("test");

      cache.set(key, { buffer });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still be retrievable
      expect(cache.get(key)).toBeDefined();
    });
  });

  describe("max size and eviction", () => {
    it("evicts oldest entries when exceeding maxSize", () => {
      const cache = new MediaCache({ maxSize: 3 });
      const buffer = Buffer.from("test");

      const key1 = cache.generateKey("msg_14");
      const key2 = cache.generateKey("msg_15");
      const key3 = cache.generateKey("msg_16");
      const key4 = cache.generateKey("msg_17");

      cache.set(key1, { buffer });
      cache.set(key2, { buffer });
      cache.set(key3, { buffer });

      expect(cache.getStats().size).toBe(3);

      // Adding 4th entry should evict the oldest (key1)
      cache.set(key4, { buffer });
      expect(cache.getStats().size).toBe(3);
      expect(cache.has(key1)).toBe(false);
      expect(cache.has(key2)).toBe(true);
      expect(cache.has(key3)).toBe(true);
      expect(cache.has(key4)).toBe(true);
    });

    it("refreshes insertion order when updating existing key", () => {
      const cache = new MediaCache({ maxSize: 2 });
      const buffer = Buffer.from("test");

      const key1 = cache.generateKey("msg_18");
      const key2 = cache.generateKey("msg_19");

      cache.set(key1, { buffer });
      cache.set(key2, { buffer });

      // Update key1 - should refresh its position to be newest
      cache.set(key1, { buffer });

      // Adding new key should evict key2 (oldest), not key1
      const key3 = cache.generateKey("msg_20");
      cache.set(key3, { buffer });

      expect(cache.has(key1)).toBe(true);
      expect(cache.has(key2)).toBe(false);
      expect(cache.has(key3)).toBe(true);
    });
  });

  describe("disabled cache", () => {
    it("returns undefined on get when disabled", () => {
      const cache = new MediaCache({ enabled: false });
      const key = cache.generateKey("msg_21");
      const buffer = Buffer.from("test");

      cache.set(key, { buffer });
      expect(cache.get(key)).toBeUndefined();
    });

    it("returns false on has when disabled", () => {
      const cache = new MediaCache({ enabled: false });
      const key = cache.generateKey("msg_22");
      const buffer = Buffer.from("test");

      cache.set(key, { buffer });
      expect(cache.has(key)).toBe(false);
    });

    it("does not store data when disabled", () => {
      const cache = new MediaCache({ enabled: false });
      const key = cache.generateKey("msg_23");
      const buffer = Buffer.from("test");

      cache.set(key, { buffer });
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("stats", () => {
    it("returns accurate cache statistics", () => {
      const cache = new MediaCache({ ttlMs: 5000, maxSize: 50 });
      const buffer = Buffer.from("test");

      cache.set(cache.generateKey("msg_24"), { buffer });
      cache.set(cache.generateKey("msg_25"), { buffer });

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(50);
      expect(stats.ttlMs).toBe(5000);
      expect(stats.enabled).toBe(true);
    });
  });

  describe("large buffer handling", () => {
    it("stores large buffers correctly", () => {
      const cache = new MediaCache();
      const largeBuffer = Buffer.alloc(10 * 1024 * 1024); // 10MB
      largeBuffer.fill(0xaa);

      const key = cache.generateKey("msg_26");
      cache.set(key, { buffer: largeBuffer });

      const retrieved = cache.get(key);
      expect(retrieved?.buffer.length).toBe(10 * 1024 * 1024);
      expect(retrieved?.buffer[0]).toBe(0xaa);
    });
  });
});
