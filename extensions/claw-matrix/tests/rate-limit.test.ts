import assert from "node:assert/strict";
/**
 * Tests for TokenBucket rate limiter.
 */
import { describe, it, beforeEach } from "node:test";
import { TokenBucket } from "../src/util/rate-limit.js";

describe("TokenBucket", () => {
  describe("constructor defaults", () => {
    it("should start with full tokens", async () => {
      const bucket = new TokenBucket(3, 1);
      // Should be able to acquire 3 tokens immediately without waiting
      const start = Date.now();
      await bucket.acquire();
      await bucket.acquire();
      await bucket.acquire();
      const elapsed = Date.now() - start;
      // All 3 should be near-instant (well under 100ms)
      assert.ok(elapsed < 100, `Expected < 100ms, got ${elapsed}ms`);
    });
  });

  describe("token acquisition", () => {
    it("should allow immediate acquire when tokens available", async () => {
      const bucket = new TokenBucket(5, 1);
      const start = Date.now();
      await bucket.acquire();
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 50, `Expected near-instant, got ${elapsed}ms`);
    });

    it("should wait when no tokens available", async () => {
      // 1 token, 10 tokens/sec refill so wait is ~100ms
      const bucket = new TokenBucket(1, 10);
      await bucket.acquire(); // use the one token
      const start = Date.now();
      await bucket.acquire(); // should wait ~100ms for refill
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 50, `Expected >= 50ms wait, got ${elapsed}ms`);
      assert.ok(elapsed < 500, `Expected < 500ms wait, got ${elapsed}ms`);
    });
  });

  describe("burst capacity", () => {
    it("should allow burst up to maxTokens", async () => {
      const bucket = new TokenBucket(5, 1);
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        await bucket.acquire();
      }
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 100, `5-token burst should be near-instant, got ${elapsed}ms`);
    });

    it("should block after burst exhausted", async () => {
      const bucket = new TokenBucket(2, 10);
      await bucket.acquire();
      await bucket.acquire();
      // Now empty — next acquire should wait
      const start = Date.now();
      await bucket.acquire();
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 50, `Expected wait after burst, got ${elapsed}ms`);
    });
  });

  describe("refill timing", () => {
    it("should refill tokens over time", async () => {
      const bucket = new TokenBucket(2, 20); // 20 tokens/sec = 1 token per 50ms
      await bucket.acquire();
      await bucket.acquire();
      // Wait for refill
      await new Promise((r) => setTimeout(r, 120));
      // Should have refilled ~2 tokens
      const start = Date.now();
      await bucket.acquire();
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 50, `Expected refilled token available, got ${elapsed}ms`);
    });

    it("should not exceed maxTokens on refill", async () => {
      const bucket = new TokenBucket(2, 100); // Fast refill
      // Wait a long time relative to refill rate
      await new Promise((r) => setTimeout(r, 200));
      // Should still only have 2 tokens (maxTokens = 2)
      const start = Date.now();
      await bucket.acquire();
      await bucket.acquire();
      const burst2 = Date.now() - start;
      assert.ok(burst2 < 50, `2-token burst should be instant after refill, got ${burst2}ms`);

      // Third should require waiting (only 2 max)
      const start2 = Date.now();
      await bucket.acquire();
      const wait = Date.now() - start2;
      assert.ok(wait >= 5, `Third token should require wait, got ${wait}ms`);
    });
  });

  describe("concurrent acquire", () => {
    it("should handle multiple concurrent acquires", async () => {
      const bucket = new TokenBucket(3, 10);
      // Fire 3 concurrent acquires — all should succeed from burst
      const results = await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire()]);
      assert.equal(results.length, 3);
    });

    it("should serialize waiting for concurrent acquires beyond burst", async () => {
      const bucket = new TokenBucket(2, 10);
      // Fire 4 concurrent: 2 burst + 2 waiting
      const start = Date.now();
      await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire(), bucket.acquire()]);
      const elapsed = Date.now() - start;
      // At least some waiting should have occurred
      assert.ok(elapsed >= 50, `Expected some waiting, got ${elapsed}ms`);
    });
  });
});
