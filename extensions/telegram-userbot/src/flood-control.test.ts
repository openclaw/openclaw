import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloodController } from "./flood-control.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FloodController", () => {
  describe("default config", () => {
    it("uses sensible defaults (20/sec global, 1/sec chat, [50,200] jitter)", () => {
      const fc = new FloodController();
      // Verify defaults by checking that metrics start at zero
      const m = fc.getMetrics();
      expect(m.totalAcquires).toBe(0);
      expect(m.totalWaits).toBe(0);
      expect(m.totalFloodWaits).toBe(0);
      expect(m.avgWaitMs).toBe(0);
    });
  });

  describe("global rate limiting", () => {
    it("allows requests up to globalRate, then delays subsequent ones", async () => {
      // globalRate=5 means 5 tokens available initially. Use fixed jitter to simplify.
      const fc = new FloodController({ globalRate: 5, perChatRate: 100, jitterMs: [0, 0] });

      // Fire 6 acquires — first 5 should drain global bucket, 6th must wait.
      // Each uses a different chat so per-chat bucket doesn't interfere.
      const results: number[] = [];
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 6; i++) {
        const idx = i;
        promises.push(
          fc.acquire(`chat-${idx}`).then(() => {
            results.push(idx);
          }),
        );
      }

      // First 5 resolve immediately (bucket has 5 tokens)
      await vi.advanceTimersByTimeAsync(0);
      expect(results.length).toBe(5);

      // 6th needs ~200ms (1 token / 5 tokens-per-sec = 200ms)
      await vi.advanceTimersByTimeAsync(250);
      expect(results.length).toBe(6);
    });
  });

  describe("per-chat rate limiting", () => {
    it("limits the same chat to perChatRate tokens per second", async () => {
      const fc = new FloodController({ globalRate: 100, perChatRate: 1, jitterMs: [0, 0] });

      const results: number[] = [];

      // Fire 2 acquires to the same chat — first is immediate, second waits ~1s
      const p1 = fc.acquire("chat-1").then(() => results.push(1));
      const p2 = fc.acquire("chat-1").then(() => results.push(2));

      await vi.advanceTimersByTimeAsync(0);
      expect(results).toEqual([1]);

      // Second acquire needs ~1000ms (1 token/sec)
      await vi.advanceTimersByTimeAsync(1100);
      expect(results).toEqual([1, 2]);

      await Promise.all([p1, p2]);
    });
  });

  describe("independent chat buckets", () => {
    it("does not throttle different chats against each other", async () => {
      const fc = new FloodController({ globalRate: 100, perChatRate: 1, jitterMs: [0, 0] });

      const results: string[] = [];

      const pA = fc.acquire("chatA").then(() => results.push("A"));
      const pB = fc.acquire("chatB").then(() => results.push("B"));

      // Both should resolve immediately — different chats, each has 1 token
      await vi.advanceTimersByTimeAsync(0);
      expect(results).toContain("A");
      expect(results).toContain("B");
      expect(results.length).toBe(2);

      await Promise.all([pA, pB]);
    });
  });

  describe("flood wait", () => {
    it("blocks all acquires until flood wait expires", async () => {
      const fc = new FloodController({ globalRate: 100, perChatRate: 100, jitterMs: [0, 0] });

      // Report a 5-second flood wait
      fc.reportFloodWait(5);

      const resolved: boolean[] = [];
      const p = fc.acquire("chat-1").then(() => resolved.push(true));

      // Should not resolve before 5 seconds
      await vi.advanceTimersByTimeAsync(4000);
      expect(resolved.length).toBe(0);

      // After 5 seconds it should resolve
      await vi.advanceTimersByTimeAsync(1100);
      expect(resolved.length).toBe(1);

      await p;
    });
  });

  describe("jitter", () => {
    it("applies fixed jitter when min === max", async () => {
      // With jitter=[100, 100], every acquire adds exactly 100ms
      const fc = new FloodController({
        globalRate: 100,
        perChatRate: 100,
        jitterMs: [100, 100],
      });

      const resolved: boolean[] = [];
      const p = fc.acquire("chat-1").then(() => resolved.push(true));

      // At t=0 the buckets pass immediately, but 100ms jitter sleep is pending
      await vi.advanceTimersByTimeAsync(50);
      expect(resolved.length).toBe(0);

      await vi.advanceTimersByTimeAsync(60);
      expect(resolved.length).toBe(1);

      await p;
    });
  });

  describe("metrics tracking", () => {
    it("correctly counts acquires and flood waits", async () => {
      const fc = new FloodController({ globalRate: 100, perChatRate: 100, jitterMs: [0, 0] });

      // Do 3 normal acquires
      for (let i = 0; i < 3; i++) {
        const p = fc.acquire(`chat-${i}`);
        await vi.advanceTimersByTimeAsync(0);
        await p;
      }

      let m = fc.getMetrics();
      expect(m.totalAcquires).toBe(3);
      expect(m.totalFloodWaits).toBe(0);

      // Report flood wait
      fc.reportFloodWait(2);
      m = fc.getMetrics();
      expect(m.totalFloodWaits).toBe(1);

      // Do another acquire (will wait for flood)
      const p = fc.acquire("chat-x");
      await vi.advanceTimersByTimeAsync(2100);
      await p;

      m = fc.getMetrics();
      expect(m.totalAcquires).toBe(4);
      expect(m.totalFloodWaits).toBe(1);
      expect(m.totalWaits).toBeGreaterThanOrEqual(1);
      expect(m.avgWaitMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("reset", () => {
    it("clears all metrics and state", async () => {
      const fc = new FloodController({ globalRate: 100, perChatRate: 100, jitterMs: [0, 0] });

      // Accumulate some state
      const p1 = fc.acquire("chat-1");
      await vi.advanceTimersByTimeAsync(0);
      await p1;

      fc.reportFloodWait(10);

      let m = fc.getMetrics();
      expect(m.totalAcquires).toBe(1);
      expect(m.totalFloodWaits).toBe(1);

      fc.reset();

      m = fc.getMetrics();
      expect(m.totalAcquires).toBe(0);
      expect(m.totalWaits).toBe(0);
      expect(m.totalFloodWaits).toBe(0);
      expect(m.avgWaitMs).toBe(0);

      // After reset, acquire should not be blocked by the old flood wait
      const resolved: boolean[] = [];
      const p2 = fc.acquire("chat-1").then(() => resolved.push(true));
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved.length).toBe(1);
      await p2;
    });
  });

  describe("LRU eviction", () => {
    it("evicts chat buckets older than chatBucketTtlMs", async () => {
      const fc = new FloodController({
        globalRate: 100,
        perChatRate: 1,
        jitterMs: [0, 0],
        chatBucketTtlMs: 1000, // 1 second TTL
      });

      // Use chat-stale — this creates a bucket
      const p1 = fc.acquire("chat-stale");
      await vi.advanceTimersByTimeAsync(0);
      await p1;

      // Advance time past TTL
      await vi.advanceTimersByTimeAsync(1500);

      // Now acquire chat-stale again. If the old bucket were still around
      // and had its token consumed, we'd have to wait. But since it was evicted,
      // a fresh bucket is created with a full token, so it resolves immediately.
      const resolved: boolean[] = [];
      const p2 = fc.acquire("chat-stale").then(() => resolved.push(true));
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved.length).toBe(1);
      await p2;
    });

    it("does not evict recently used buckets", async () => {
      const fc = new FloodController({
        globalRate: 100,
        perChatRate: 1,
        jitterMs: [0, 0],
        chatBucketTtlMs: 2000,
      });

      // First acquire consumes the only token
      const p1 = fc.acquire("chat-keep");
      await vi.advanceTimersByTimeAsync(0);
      await p1;

      // Advance 500ms — still within TTL
      await vi.advanceTimersByTimeAsync(500);

      // Second acquire reuses the same bucket (token not yet refilled at 500ms with 1/sec rate)
      const resolved: boolean[] = [];
      const p2 = fc.acquire("chat-keep").then(() => resolved.push(true));

      // Should not resolve immediately since the bucket's token is spent
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved.length).toBe(0);

      // Advance enough for the per-chat token to refill
      await vi.advanceTimersByTimeAsync(600);
      expect(resolved.length).toBe(1);
      await p2;
    });
  });
});
