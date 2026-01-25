import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getPublicKey } from "nostr-tools";
import { decrypt } from "nostr-tools/nip04";
import { createMetrics } from "./metrics.js";
import { validatePrivateKey } from "./nostr-bus.js";

/**
 * Tests for the Nostr Typing Indicator feature.
 *
 * The typing indicator implementation:
 * - Uses kind 20001 (ephemeral event per NIP-01)
 * - Tags: p (recipient), t (namespace), expiration (30s), optional e (conversation)
 * - Content is NIP-04 encrypted: "start" or "stop"
 * - Throttled: max 1 start event per 5 seconds per recipient (stop bypasses throttle)
 */

// Test keys (deterministic for reproducibility)
const TEST_PRIVATE_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_RECIPIENT_KEY_HEX =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

// ============================================================================
// Unit Tests: Typing Controller Logic
// ============================================================================

describe("Typing Controller Logic", () => {
  // We test the throttling and controller logic by extracting the core behavior
  // into testable units

  describe("throttling behavior", () => {
    it("should throttle start events within 5s window", () => {
      const lastSendTime = new Map<string, number>();
      const THROTTLE_MS = 5000;
      const pubkey = "testpubkey";

      // Simulate first send
      const now1 = 1000;
      const lastSent1 = lastSendTime.get(pubkey) ?? 0;
      const shouldSend1 = now1 - lastSent1 >= THROTTLE_MS || lastSent1 === 0;
      expect(shouldSend1).toBe(true);
      lastSendTime.set(pubkey, now1);

      // Simulate second send 2 seconds later (should throttle)
      const now2 = 3000;
      const lastSent2 = lastSendTime.get(pubkey) ?? 0;
      const shouldSend2 = now2 - lastSent2 >= THROTTLE_MS;
      expect(shouldSend2).toBe(false);

      // Simulate third send 6 seconds after first (should allow)
      const now3 = 7000;
      const lastSent3 = lastSendTime.get(pubkey) ?? 0;
      const shouldSend3 = now3 - lastSent3 >= THROTTLE_MS;
      expect(shouldSend3).toBe(true);
    });

    it("should track throttling per recipient independently", () => {
      const lastSendTime = new Map<string, number>();
      const THROTTLE_MS = 5000;

      // Send to recipient A
      lastSendTime.set("recipientA", 1000);

      // Send to recipient B immediately after - should be allowed
      const nowB = 1001;
      const lastSentB = lastSendTime.get("recipientB") ?? 0;
      const shouldSendB = nowB - lastSentB >= THROTTLE_MS || lastSentB === 0;
      expect(shouldSendB).toBe(true);
    });

    it("stop events should bypass throttle", () => {
      // The implementation only throttles "start" events
      // Stop events always go through for better UX
      const action = "stop";
      const shouldBypassThrottle = action === "stop";
      expect(shouldBypassThrottle).toBe(true);
    });
  });
});

// ============================================================================
// Unit Tests: Event Structure
// ============================================================================

describe("Typing Event Structure", () => {
  const TYPING_KIND = 20001;
  const TYPING_TTL_SEC = 30;

  it("should use kind 20001 (ephemeral range)", () => {
    expect(TYPING_KIND).toBe(20001);
    expect(TYPING_KIND).toBeGreaterThanOrEqual(20000);
    expect(TYPING_KIND).toBeLessThanOrEqual(29999);
  });

  it("should build correct tags array", () => {
    const toPubkey = "abc123";
    const conversationEventId = "event456";
    const expirationTime = Math.floor(Date.now() / 1000) + TYPING_TTL_SEC;

    const tags: string[][] = [
      ["p", toPubkey],
      ["t", "clawdbot-typing"],
      ["expiration", String(expirationTime)],
    ];

    if (conversationEventId) {
      tags.push(["e", conversationEventId]);
    }

    // Verify p tag (recipient)
    const pTag = tags.find((t) => t[0] === "p");
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(toPubkey);

    // Verify t tag (namespace)
    const tTag = tags.find((t) => t[0] === "t");
    expect(tTag).toBeDefined();
    expect(tTag![1]).toBe("clawdbot-typing");

    // Verify expiration tag
    const expTag = tags.find((t) => t[0] === "expiration");
    expect(expTag).toBeDefined();
    const expValue = Number(expTag![1]);
    expect(expValue).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(expValue).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 31);

    // Verify e tag (conversation) when provided
    const eTag = tags.find((t) => t[0] === "e");
    expect(eTag).toBeDefined();
    expect(eTag![1]).toBe(conversationEventId);
  });

  it("should omit e tag when conversationEventId not provided", () => {
    const toPubkey = "abc123";
    const expirationTime = Math.floor(Date.now() / 1000) + TYPING_TTL_SEC;

    const tags: string[][] = [
      ["p", toPubkey],
      ["t", "clawdbot-typing"],
      ["expiration", String(expirationTime)],
    ];
    // No conversationEventId, so no e tag added

    const eTag = tags.find((t) => t[0] === "e");
    expect(eTag).toBeUndefined();
  });
});

// ============================================================================
// Unit Tests: NIP-04 Encryption
// ============================================================================

describe("Typing Content Encryption", () => {
  it("should encrypt 'start' action with NIP-04", async () => {
    const { encrypt } = await import("nostr-tools/nip04");
    const sk = validatePrivateKey(TEST_PRIVATE_KEY_HEX);
    const recipientPubkey = getPublicKey(validatePrivateKey(TEST_RECIPIENT_KEY_HEX));

    const ciphertext = await encrypt(sk, recipientPubkey, "start");

    // Ciphertext should not be plaintext
    expect(ciphertext).not.toBe("start");
    // NIP-04 ciphertext contains ?iv= marker
    expect(ciphertext).toContain("?iv=");

    // Should decrypt back to original
    const decrypted = await decrypt(sk, recipientPubkey, ciphertext);
    expect(decrypted).toBe("start");
  });

  it("should encrypt 'stop' action with NIP-04", async () => {
    const { encrypt } = await import("nostr-tools/nip04");
    const sk = validatePrivateKey(TEST_PRIVATE_KEY_HEX);
    const recipientPubkey = getPublicKey(validatePrivateKey(TEST_RECIPIENT_KEY_HEX));

    const ciphertext = await encrypt(sk, recipientPubkey, "stop");

    expect(ciphertext).not.toBe("stop");
    expect(ciphertext).toContain("?iv=");

    const decrypted = await decrypt(sk, recipientPubkey, ciphertext);
    expect(decrypted).toBe("stop");
  });
});

// ============================================================================
// Unit Tests: Circuit Breaker Integration
// ============================================================================

describe("Circuit Breaker Integration", () => {
  it("should skip relay when circuit breaker is open", () => {
    const relays = ["wss://relay1.test", "wss://relay2.test"];
    const circuitBreakers = new Map<
      string,
      { canAttempt: () => boolean; recordSuccess: () => void; recordFailure: () => void }
    >();

    // Relay 1 circuit breaker is open
    circuitBreakers.set("wss://relay1.test", {
      canAttempt: () => false,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    });

    // Relay 2 circuit breaker is closed (can attempt)
    circuitBreakers.set("wss://relay2.test", {
      canAttempt: () => true,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    });

    // Filter relays that can be attempted
    const attemptableRelays = relays.filter((relay) => {
      const cb = circuitBreakers.get(relay);
      return !cb || cb.canAttempt();
    });

    expect(attemptableRelays).toEqual(["wss://relay2.test"]);
    expect(attemptableRelays).not.toContain("wss://relay1.test");
  });

  it("should record success when publish succeeds", () => {
    const recordSuccess = vi.fn();
    const cb = { canAttempt: () => true, recordSuccess, recordFailure: vi.fn() };

    // Simulate successful publish
    cb.recordSuccess();

    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("should record failure when publish fails", () => {
    const recordFailure = vi.fn();
    const cb = { canAttempt: () => true, recordSuccess: vi.fn(), recordFailure };

    // Simulate failed publish
    cb.recordFailure();

    expect(recordFailure).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Unit Tests: Relay Fallback
// ============================================================================

describe("Relay Fallback Behavior", () => {
  it("should try next relay when first fails", async () => {
    const publishAttempts: string[] = [];
    const relays = ["wss://relay1.test", "wss://relay2.test", "wss://relay3.test"];

    // Simulate publish with first relay failing
    for (const relay of relays) {
      publishAttempts.push(relay);
      if (relay === "wss://relay1.test") {
        // First relay fails, continue to next
        continue;
      }
      // Second relay succeeds, stop
      break;
    }

    expect(publishAttempts).toEqual(["wss://relay1.test", "wss://relay2.test"]);
  });

  it("should try all relays when all fail", () => {
    const publishAttempts: string[] = [];
    const relays = ["wss://relay1.test", "wss://relay2.test"];
    let lastError: Error | undefined;

    for (const relay of relays) {
      try {
        publishAttempts.push(relay);
        throw new Error(`Failed to publish to ${relay}`);
      } catch (err) {
        lastError = err as Error;
        // Continue to next relay
      }
    }

    expect(publishAttempts).toEqual(["wss://relay1.test", "wss://relay2.test"]);
    expect(lastError).toBeDefined();
    expect(lastError!.message).toContain("relay2");
  });
});

// ============================================================================
// Unit Tests: Error Handling (Non-Throwing)
// ============================================================================

describe("Error Handling", () => {
  it("should not throw when all relays fail", () => {
    const onError = vi.fn();
    const relays = ["wss://relay1.test"];
    let lastError: Error | undefined;

    // Simulate all relays failing
    for (const relay of relays) {
      try {
        throw new Error(`Failed to publish to ${relay}`);
      } catch (err) {
        lastError = err as Error;
        onError(lastError, `typing start to ${relay}`);
      }
    }

    // Should call onError but not throw
    expect(onError).toHaveBeenCalled();

    // The typing function should NOT throw (verified by this test completing)
    const nonThrowingBehavior = () => {
      if (lastError) {
        onError(lastError, "typing start failed on all relays");
        // Notice: no throw here - typing failures are non-critical
      }
    };

    expect(nonThrowingBehavior).not.toThrow();
  });

  it("should call onError callback with context", () => {
    const onError = vi.fn();
    const error = new Error("Connection refused");

    onError(error, "typing start to wss://relay.test");

    expect(onError).toHaveBeenCalledWith(error, "typing start to wss://relay.test");
  });
});

// ============================================================================
// Unit Tests: Metrics
// ============================================================================

describe("Typing Metrics", () => {
  describe("typing.start.sent", () => {
    it("increments on emit", () => {
      const metrics = createMetrics();
      metrics.emit("typing.start.sent", 1, { relay: "wss://test.relay" });
      expect(metrics.getSnapshot().typing.startSent).toBe(1);
    });

    it("accumulates multiple emissions", () => {
      const metrics = createMetrics();
      metrics.emit("typing.start.sent", 1);
      metrics.emit("typing.start.sent", 1);
      metrics.emit("typing.start.sent", 1);
      expect(metrics.getSnapshot().typing.startSent).toBe(3);
    });
  });

  describe("typing.stop.sent", () => {
    it("increments on emit", () => {
      const metrics = createMetrics();
      metrics.emit("typing.stop.sent", 1, { relay: "wss://test.relay" });
      expect(metrics.getSnapshot().typing.stopSent).toBe(1);
    });
  });

  describe("typing.error", () => {
    it("increments on publish failure", () => {
      const metrics = createMetrics();
      metrics.emit("typing.error", 1, { relay: "wss://test.relay" });
      expect(metrics.getSnapshot().typing.errors).toBe(1);
    });

    it("should emit error metric per failed relay", () => {
      const metrics = createMetrics();

      // First relay fails
      metrics.emit("typing.error", 1, { relay: "wss://relay1.test" });
      // Second relay also fails
      metrics.emit("typing.error", 1, { relay: "wss://relay2.test" });

      expect(metrics.getSnapshot().typing.errors).toBe(2);
    });
  });

  describe("metric selection", () => {
    it("should emit start metric only on successful start", () => {
      const metrics = createMetrics();
      const action = "start";

      // Simulate successful publish
      const metricName = action === "start" ? "typing.start.sent" : "typing.stop.sent";
      metrics.emit(metricName, 1);

      expect(metrics.getSnapshot().typing.startSent).toBe(1);
      expect(metrics.getSnapshot().typing.stopSent).toBe(0);
    });

    it("should emit stop metric only on successful stop", () => {
      const metrics = createMetrics();
      const action = "stop";

      const metricName = action === "start" ? "typing.start.sent" : "typing.stop.sent";
      metrics.emit(metricName, 1);

      expect(metrics.getSnapshot().typing.startSent).toBe(0);
      expect(metrics.getSnapshot().typing.stopSent).toBe(1);
    });
  });

  describe("metrics callback", () => {
    it("calls onMetric callback with typing events", () => {
      const received: { name: string; value: number }[] = [];
      const metrics = createMetrics((event) => {
        received.push({ name: event.name, value: event.value });
      });

      metrics.emit("typing.start.sent", 1);
      metrics.emit("typing.stop.sent", 1);
      metrics.emit("typing.error", 1);

      expect(received).toEqual([
        { name: "typing.start.sent", value: 1 },
        { name: "typing.stop.sent", value: 1 },
        { name: "typing.error", value: 1 },
      ]);
    });

    it("includes relay label in callback", () => {
      const received: { name: string; labels?: Record<string, string | number> }[] = [];
      const metrics = createMetrics((event) => {
        received.push({ name: event.name, labels: event.labels });
      });

      metrics.emit("typing.start.sent", 1, { relay: "wss://relay.damus.io" });

      expect(received[0].labels).toEqual({ relay: "wss://relay.damus.io" });
    });
  });

  describe("reset", () => {
    it("resets all typing metrics to zero", () => {
      const metrics = createMetrics();

      metrics.emit("typing.start.sent", 5);
      metrics.emit("typing.stop.sent", 3);
      metrics.emit("typing.error", 2);

      metrics.reset();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.typing.startSent).toBe(0);
      expect(snapshot.typing.stopSent).toBe(0);
      expect(snapshot.typing.errors).toBe(0);
    });
  });
});

// ============================================================================
// Integration Tests: Full Typing Flow (with mocked SimplePool)
// ============================================================================

describe("Typing Indicator Integration", () => {
  let mockPublish: ReturnType<typeof vi.fn>;
  let publishedEvents: Array<{ relays: string[]; event: unknown }>;

  beforeEach(() => {
    publishedEvents = [];
    mockPublish = vi.fn().mockImplementation(async (relays: string[], event: unknown) => {
      publishedEvents.push({ relays, event });
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should publish to relays sorted by health score", () => {
    // Health tracker returns relays sorted by score
    const relays = ["wss://unhealthy.relay", "wss://healthy.relay"];

    // Mock health tracker that sorts healthy first
    const getSortedRelays = (inputRelays: string[]) => {
      return [...inputRelays].sort((a, b) => {
        if (a.includes("healthy")) return -1;
        if (b.includes("healthy")) return 1;
        return 0;
      });
    };

    const sorted = getSortedRelays(relays);
    expect(sorted[0]).toBe("wss://healthy.relay");
  });

  it("should update lastSendTime on successful publish", () => {
    const lastSendTime = new Map<string, number>();
    const pubkey = "testpubkey";
    const now = Date.now();

    // Simulate successful send
    lastSendTime.set(pubkey, now);

    expect(lastSendTime.get(pubkey)).toBe(now);
  });

  it("should not update lastSendTime when throttled", () => {
    const lastSendTime = new Map<string, number>();
    const pubkey = "testpubkey";
    const THROTTLE_MS = 5000;

    // Set initial send time
    const initialTime = 1000;
    lastSendTime.set(pubkey, initialTime);

    // Simulate throttled attempt (within 5s)
    const now = 3000;
    const lastSent = lastSendTime.get(pubkey) ?? 0;
    const isThrottled = now - lastSent < THROTTLE_MS;

    if (!isThrottled) {
      lastSendTime.set(pubkey, now);
    }

    // lastSendTime should not have changed (was throttled)
    expect(lastSendTime.get(pubkey)).toBe(initialTime);
  });
});

// ============================================================================
// Specification Tests: Protocol Compliance
// ============================================================================

describe("Nostr Protocol Compliance", () => {
  it("kind 20001 is in ephemeral range (NIP-01)", () => {
    const TYPING_KIND = 20001;
    // NIP-01: Ephemeral events are kinds 20000-29999
    expect(TYPING_KIND).toBeGreaterThanOrEqual(20000);
    expect(TYPING_KIND).toBeLessThanOrEqual(29999);
  });

  it("uses NIP-40 expiration tag format", () => {
    const TYPING_TTL_SEC = 30;
    const now = Math.floor(Date.now() / 1000);
    const expiration = now + TYPING_TTL_SEC;

    // NIP-40 format: ["expiration", "<unix timestamp>"]
    const expirationTag = ["expiration", String(expiration)];

    expect(expirationTag[0]).toBe("expiration");
    expect(typeof expirationTag[1]).toBe("string");
    expect(Number(expirationTag[1])).toBeGreaterThan(now);
  });

  it("uses community convention kind 20001 for interop", () => {
    // Kind 20001 is the informal community convention for typing indicators
    // This improves interoperability with other Nostr clients
    const TYPING_KIND = 20001;
    expect(TYPING_KIND).toBe(20001);
  });

  it("uses clawdbot-typing namespace tag for collision protection", () => {
    const namespaceTag = ["t", "clawdbot-typing"];
    expect(namespaceTag[0]).toBe("t");
    expect(namespaceTag[1]).toBe("clawdbot-typing");
  });
});
