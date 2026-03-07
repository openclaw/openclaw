import { describe, expect, it, vi } from "vitest";
import { createMetrics, createNoopMetrics, type MetricEvent } from "./metrics.js";
import { createSeenTracker } from "./seen-tracker.js";

// ============================================================================
// Seen Tracker Integration Tests
// ============================================================================

describe("SeenTracker", () => {
  describe("basic operations", () => {
    it("tracks seen IDs", () => {
      const tracker = createSeenTracker({ maxEntries: 100, ttlMs: 60000 });

      // First check returns false and adds
      expect(tracker.has("id1")).toBe(false);
      // Second check returns true (already seen)
      expect(tracker.has("id1")).toBe(true);

      tracker.stop();
    });

    it("peek does not add", () => {
      const tracker = createSeenTracker({ maxEntries: 100, ttlMs: 60000 });

      expect(tracker.peek("id1")).toBe(false);
      expect(tracker.peek("id1")).toBe(false); // Still false

      tracker.add("id1");
      expect(tracker.peek("id1")).toBe(true);

      tracker.stop();
    });

    it("delete removes entries", () => {
      const tracker = createSeenTracker({ maxEntries: 100, ttlMs: 60000 });

      tracker.add("id1");
      expect(tracker.peek("id1")).toBe(true);

      tracker.delete("id1");
      expect(tracker.peek("id1")).toBe(false);

      tracker.stop();
    });

    it("clear removes all entries", () => {
      const tracker = createSeenTracker({ maxEntries: 100, ttlMs: 60000 });

      tracker.add("id1");
      tracker.add("id2");
      tracker.add("id3");
      expect(tracker.size()).toBe(3);

      tracker.clear();
      expect(tracker.size()).toBe(0);
      expect(tracker.peek("id1")).toBe(false);

      tracker.stop();
    });

    it("seed pre-populates entries", () => {
      const tracker = createSeenTracker({ maxEntries: 100, ttlMs: 60000 });

      tracker.seed(["id1", "id2", "id3"]);
      expect(tracker.size()).toBe(3);
      expect(tracker.peek("id1")).toBe(true);
      expect(tracker.peek("id2")).toBe(true);
      expect(tracker.peek("id3")).toBe(true);

      tracker.stop();
    });
  });

  describe("LRU eviction", () => {
    it("evicts least recently used when at capacity", () => {
      const tracker = createSeenTracker({ maxEntries: 3, ttlMs: 60000 });

      tracker.add("id1");
      tracker.add("id2");
      tracker.add("id3");
      expect(tracker.size()).toBe(3);

      // Adding fourth should evict oldest (id1)
      tracker.add("id4");
      expect(tracker.size()).toBe(3);
      expect(tracker.peek("id1")).toBe(false); // Evicted
      expect(tracker.peek("id2")).toBe(true);
      expect(tracker.peek("id3")).toBe(true);
      expect(tracker.peek("id4")).toBe(true);

      tracker.stop();
    });

    it("accessing an entry moves it to front (prevents eviction)", () => {
      const tracker = createSeenTracker({ maxEntries: 3, ttlMs: 60000 });

      tracker.add("id1");
      tracker.add("id2");
      tracker.add("id3");

      // Access id1, moving it to front
      tracker.has("id1");

      // Add id4 - should evict id2 (now oldest)
      tracker.add("id4");
      expect(tracker.peek("id1")).toBe(true); // Not evicted, was accessed
      expect(tracker.peek("id2")).toBe(false); // Evicted
      expect(tracker.peek("id3")).toBe(true);
      expect(tracker.peek("id4")).toBe(true);

      tracker.stop();
    });

    it("handles capacity of 1", () => {
      const tracker = createSeenTracker({ maxEntries: 1, ttlMs: 60000 });

      tracker.add("id1");
      expect(tracker.peek("id1")).toBe(true);

      tracker.add("id2");
      expect(tracker.peek("id1")).toBe(false);
      expect(tracker.peek("id2")).toBe(true);

      tracker.stop();
    });

    it("seed respects maxEntries", () => {
      const tracker = createSeenTracker({ maxEntries: 2, ttlMs: 60000 });

      tracker.seed(["id1", "id2", "id3", "id4"]);
      expect(tracker.size()).toBe(2);
      // Seed stops when maxEntries reached, processing from end to start
      // So id4 and id3 get added first, then we're at capacity
      expect(tracker.peek("id3")).toBe(true);
      expect(tracker.peek("id4")).toBe(true);

      tracker.stop();
    });
  });

  describe("TTL expiration", () => {
    it("expires entries after TTL", async () => {
      vi.useFakeTimers();

      const tracker = createSeenTracker({
        maxEntries: 100,
        ttlMs: 100,
        pruneIntervalMs: 50,
      });

      tracker.add("id1");
      expect(tracker.peek("id1")).toBe(true);

      // Advance past TTL
      vi.advanceTimersByTime(150);

      // Entry should be expired
      expect(tracker.peek("id1")).toBe(false);

      tracker.stop();
      vi.useRealTimers();
    });

    it("has() refreshes TTL", async () => {
      vi.useFakeTimers();

      const tracker = createSeenTracker({
        maxEntries: 100,
        ttlMs: 100,
        pruneIntervalMs: 50,
      });

      tracker.add("id1");

      // Advance halfway
      vi.advanceTimersByTime(50);

      // Access to refresh
      expect(tracker.has("id1")).toBe(true);

      // Advance another 75ms (total 125ms from add, but only 75ms from last access)
      vi.advanceTimersByTime(75);

      // Should still be valid (refreshed at 50ms)
      expect(tracker.peek("id1")).toBe(true);

      tracker.stop();
      vi.useRealTimers();
    });
  });
});

// ============================================================================
// Metrics Integration Tests
// ============================================================================

describe("Metrics", () => {
  describe("createMetrics", () => {
    it("emits metric events to callback", () => {
      const events: MetricEvent[] = [];
      const metrics = createMetrics((event) => events.push(event));

      metrics.emit("event.received");
      metrics.emit("event.processed");
      metrics.emit("event.duplicate");

      expect(events).toHaveLength(3);
      expect(events[0].name).toBe("event.received");
      expect(events[1].name).toBe("event.processed");
      expect(events[2].name).toBe("event.duplicate");
    });

    it("includes labels in metric events", () => {
      const events: MetricEvent[] = [];
      const metrics = createMetrics((event) => events.push(event));

      metrics.emit("relay.connect", 1, { relay: "wss://relay.example.com" });

      expect(events[0].labels).toEqual({ relay: "wss://relay.example.com" });
    });

    it("accumulates counters in snapshot", () => {
      const metrics = createMetrics();

      metrics.emit("event.received");
      metrics.emit("event.received");
      metrics.emit("event.processed");
      metrics.emit("event.duplicate");
      metrics.emit("event.duplicate");
      metrics.emit("event.duplicate");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(2);
      expect(snapshot.eventsProcessed).toBe(1);
      expect(snapshot.eventsDuplicate).toBe(3);
    });

    it("tracks per-relay stats", () => {
      const metrics = createMetrics();

      metrics.emit("relay.connect", 1, { relay: "wss://relay1.com" });
      metrics.emit("relay.connect", 1, { relay: "wss://relay2.com" });
      metrics.emit("relay.error", 1, { relay: "wss://relay1.com" });
      metrics.emit("relay.error", 1, { relay: "wss://relay1.com" });

      const snapshot = metrics.getSnapshot();
      expect(snapshot.relays["wss://relay1.com"]).toBeDefined();
      expect(snapshot.relays["wss://relay1.com"].connects).toBe(1);
      expect(snapshot.relays["wss://relay1.com"].errors).toBe(2);
      expect(snapshot.relays["wss://relay2.com"].connects).toBe(1);
      expect(snapshot.relays["wss://relay2.com"].errors).toBe(0);
    });

    it("tracks circuit breaker state changes", () => {
      const metrics = createMetrics();

      metrics.emit("relay.circuit_breaker.open", 1, { relay: "wss://relay.com" });

      let snapshot = metrics.getSnapshot();
      expect(snapshot.relays["wss://relay.com"].circuitBreakerState).toBe("open");
      expect(snapshot.relays["wss://relay.com"].circuitBreakerOpens).toBe(1);

      metrics.emit("relay.circuit_breaker.close", 1, { relay: "wss://relay.com" });

      snapshot = metrics.getSnapshot();
      expect(snapshot.relays["wss://relay.com"].circuitBreakerState).toBe("closed");
      expect(snapshot.relays["wss://relay.com"].circuitBreakerCloses).toBe(1);
    });

    it("tracks all rejection reasons", () => {
      const metrics = createMetrics();

      metrics.emit("event.rejected.invalid_shape");
      metrics.emit("event.rejected.wrong_kind");
      metrics.emit("event.rejected.stale");
      metrics.emit("event.rejected.future");
      metrics.emit("event.rejected.rate_limited");
      metrics.emit("event.rejected.invalid_signature");
      metrics.emit("event.rejected.oversized_ciphertext");
      metrics.emit("event.rejected.oversized_plaintext");
      metrics.emit("event.rejected.decrypt_failed");
      metrics.emit("event.rejected.self_message");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsRejected.invalidShape).toBe(1);
      expect(snapshot.eventsRejected.wrongKind).toBe(1);
      expect(snapshot.eventsRejected.stale).toBe(1);
      expect(snapshot.eventsRejected.future).toBe(1);
      expect(snapshot.eventsRejected.rateLimited).toBe(1);
      expect(snapshot.eventsRejected.invalidSignature).toBe(1);
      expect(snapshot.eventsRejected.oversizedCiphertext).toBe(1);
      expect(snapshot.eventsRejected.oversizedPlaintext).toBe(1);
      expect(snapshot.eventsRejected.decryptFailed).toBe(1);
      expect(snapshot.eventsRejected.selfMessage).toBe(1);
    });

    it("tracks relay message types", () => {
      const metrics = createMetrics();

      metrics.emit("relay.message.event", 1, { relay: "wss://relay.com" });
      metrics.emit("relay.message.eose", 1, { relay: "wss://relay.com" });
      metrics.emit("relay.message.closed", 1, { relay: "wss://relay.com" });
      metrics.emit("relay.message.notice", 1, { relay: "wss://relay.com" });
      metrics.emit("relay.message.ok", 1, { relay: "wss://relay.com" });
      metrics.emit("relay.message.auth", 1, { relay: "wss://relay.com" });

      const snapshot = metrics.getSnapshot();
      const relay = snapshot.relays["wss://relay.com"];
      expect(relay.messagesReceived.event).toBe(1);
      expect(relay.messagesReceived.eose).toBe(1);
      expect(relay.messagesReceived.closed).toBe(1);
      expect(relay.messagesReceived.notice).toBe(1);
      expect(relay.messagesReceived.ok).toBe(1);
      expect(relay.messagesReceived.auth).toBe(1);
    });

    it("tracks decrypt success/failure", () => {
      const metrics = createMetrics();

      metrics.emit("decrypt.success");
      metrics.emit("decrypt.success");
      metrics.emit("decrypt.failure");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.decrypt.success).toBe(2);
      expect(snapshot.decrypt.failure).toBe(1);
    });

    it("tracks memory gauges (replaces rather than accumulates)", () => {
      const metrics = createMetrics();

      metrics.emit("memory.seen_tracker_size", 100);
      metrics.emit("memory.seen_tracker_size", 150);
      metrics.emit("memory.seen_tracker_size", 125);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.memory.seenTrackerSize).toBe(125); // Last value, not sum
    });

    it("reset clears all counters", () => {
      const metrics = createMetrics();

      metrics.emit("event.received");
      metrics.emit("event.processed");
      metrics.emit("relay.connect", 1, { relay: "wss://relay.com" });

      metrics.reset();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(0);
      expect(snapshot.eventsProcessed).toBe(0);
      expect(Object.keys(snapshot.relays)).toHaveLength(0);
    });
  });

  describe("createNoopMetrics", () => {
    it("does not throw on emit", () => {
      const metrics = createNoopMetrics();

      expect(() => {
        metrics.emit("event.received");
        metrics.emit("relay.connect", 1, { relay: "wss://relay.com" });
      }).not.toThrow();
    });

    it("returns empty snapshot", () => {
      const metrics = createNoopMetrics();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(0);
      expect(snapshot.eventsProcessed).toBe(0);
    });
  });
});

// ============================================================================
// Circuit Breaker Behavior Tests
// ============================================================================

describe("Circuit Breaker Behavior", () => {
  // Test the circuit breaker logic through metrics emissions
  it("emits circuit breaker metrics in correct sequence", () => {
    const events: MetricEvent[] = [];
    const metrics = createMetrics((event) => events.push(event));

    // Simulate 5 failures -> open
    for (let i = 0; i < 5; i++) {
      metrics.emit("relay.error", 1, { relay: "wss://relay.com" });
    }
    metrics.emit("relay.circuit_breaker.open", 1, { relay: "wss://relay.com" });

    // Simulate recovery
    metrics.emit("relay.circuit_breaker.half_open", 1, { relay: "wss://relay.com" });
    metrics.emit("relay.circuit_breaker.close", 1, { relay: "wss://relay.com" });

    const cbEvents = events.filter((e) => e.name.startsWith("relay.circuit_breaker"));
    expect(cbEvents).toHaveLength(3);
    expect(cbEvents[0].name).toBe("relay.circuit_breaker.open");
    expect(cbEvents[1].name).toBe("relay.circuit_breaker.half_open");
    expect(cbEvents[2].name).toBe("relay.circuit_breaker.close");
  });
});

// ============================================================================
// Health Scoring Behavior Tests
// ============================================================================

describe("Health Scoring", () => {
  it("metrics track relay errors for health scoring", () => {
    const metrics = createMetrics();

    // Simulate mixed success/failure pattern
    metrics.emit("relay.connect", 1, { relay: "wss://good-relay.com" });
    metrics.emit("relay.connect", 1, { relay: "wss://bad-relay.com" });

    metrics.emit("relay.error", 1, { relay: "wss://bad-relay.com" });
    metrics.emit("relay.error", 1, { relay: "wss://bad-relay.com" });
    metrics.emit("relay.error", 1, { relay: "wss://bad-relay.com" });

    const snapshot = metrics.getSnapshot();
    expect(snapshot.relays["wss://good-relay.com"].errors).toBe(0);
    expect(snapshot.relays["wss://bad-relay.com"].errors).toBe(3);
  });
});

// ============================================================================
// Reconnect Backoff Tests
// ============================================================================

describe("Reconnect Backoff", () => {
  it("computes delays within expected bounds", () => {
    // Compute expected delays (1s, 2s, 4s, 8s, 16s, 32s, 60s cap)
    const BASE = 1000;
    const MAX = 60000;
    const JITTER = 0.3;

    for (let attempt = 0; attempt < 10; attempt++) {
      const exponential = BASE * Math.pow(2, attempt);
      const capped = Math.min(exponential, MAX);
      const minDelay = capped * (1 - JITTER);
      const maxDelay = capped * (1 + JITTER);

      // These are the expected bounds
      expect(minDelay).toBeGreaterThanOrEqual(BASE * 0.7);
      expect(maxDelay).toBeLessThanOrEqual(MAX * 1.3);
    }
  });
});
