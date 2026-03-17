import { describe, expect, it } from "vitest";
import { createMetrics } from "./metrics.js";
import { validatePrivateKey, isValidPubkey, normalizePubkey } from "./nostr-bus.js";
import { createSeenTracker } from "./seen-tracker.js";
describe("validatePrivateKey fuzz", () => {
  describe("type confusion", () => {
    it("rejects null input", () => {
      expect(() => validatePrivateKey(null)).toThrow();
    });
    it("rejects undefined input", () => {
      expect(() => validatePrivateKey(void 0)).toThrow();
    });
    it("rejects number input", () => {
      expect(() => validatePrivateKey(123)).toThrow();
    });
    it("rejects boolean input", () => {
      expect(() => validatePrivateKey(true)).toThrow();
    });
    it("rejects object input", () => {
      expect(() => validatePrivateKey({})).toThrow();
    });
    it("rejects array input", () => {
      expect(() => validatePrivateKey([])).toThrow();
    });
    it("rejects function input", () => {
      expect(() => validatePrivateKey((() => {
      }))).toThrow();
    });
  });
  describe("unicode attacks", () => {
    it("rejects unicode lookalike characters", () => {
      const withZeroWidth = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\u200Bf";
      expect(() => validatePrivateKey(withZeroWidth)).toThrow();
    });
    it("rejects RTL override", () => {
      const withRtl = "\u202E0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      expect(() => validatePrivateKey(withRtl)).toThrow();
    });
    it("rejects homoglyph 'a' (Cyrillic \u0430)", () => {
      const withCyrillicA = "0123456789\u0430bcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      expect(() => validatePrivateKey(withCyrillicA)).toThrow();
    });
    it("rejects emoji", () => {
      const withEmoji = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab\u{1F600}";
      expect(() => validatePrivateKey(withEmoji)).toThrow();
    });
    it("rejects combining characters", () => {
      const withCombining = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\u0301";
      expect(() => validatePrivateKey(withCombining)).toThrow();
    });
  });
  describe("injection attempts", () => {
    it("rejects null byte injection", () => {
      const withNullByte = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\0f";
      expect(() => validatePrivateKey(withNullByte)).toThrow();
    });
    it("rejects newline injection", () => {
      const withNewline = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\nf";
      expect(() => validatePrivateKey(withNewline)).toThrow();
    });
    it("rejects carriage return injection", () => {
      const withCR = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\rf";
      expect(() => validatePrivateKey(withCR)).toThrow();
    });
    it("rejects tab injection", () => {
      const withTab = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde	f";
      expect(() => validatePrivateKey(withTab)).toThrow();
    });
    it("rejects form feed injection", () => {
      const withFormFeed = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\ff";
      expect(() => validatePrivateKey(withFormFeed)).toThrow();
    });
  });
  describe("edge cases", () => {
    it("rejects very long string", () => {
      const veryLong = "a".repeat(1e4);
      expect(() => validatePrivateKey(veryLong)).toThrow();
    });
    it("rejects string of spaces matching length", () => {
      const spaces = " ".repeat(64);
      expect(() => validatePrivateKey(spaces)).toThrow();
    });
    it("rejects hex with spaces between characters", () => {
      const withSpaces = "01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef";
      expect(() => validatePrivateKey(withSpaces)).toThrow();
    });
  });
  describe("nsec format edge cases", () => {
    it("rejects nsec with invalid bech32 characters", () => {
      const invalidBech32 = "nsec1qypqxpq9qtpqscx7peytbfwtdjmcv0mrz5rjpej8vjppfkqfqy8skqfv3l";
      expect(() => validatePrivateKey(invalidBech32)).toThrow();
    });
    it("rejects nsec with wrong prefix", () => {
      expect(() => validatePrivateKey("nsec0aaaa")).toThrow();
    });
    it("rejects partial nsec", () => {
      expect(() => validatePrivateKey("nsec1")).toThrow();
    });
  });
});
describe("isValidPubkey fuzz", () => {
  describe("type confusion", () => {
    it("handles null gracefully", () => {
      expect(isValidPubkey(null)).toBe(false);
    });
    it("handles undefined gracefully", () => {
      expect(isValidPubkey(void 0)).toBe(false);
    });
    it("handles number gracefully", () => {
      expect(isValidPubkey(123)).toBe(false);
    });
    it("handles object gracefully", () => {
      expect(isValidPubkey({})).toBe(false);
    });
  });
  describe("malicious inputs", () => {
    it("rejects __proto__ key", () => {
      expect(isValidPubkey("__proto__")).toBe(false);
    });
    it("rejects constructor key", () => {
      expect(isValidPubkey("constructor")).toBe(false);
    });
    it("rejects toString key", () => {
      expect(isValidPubkey("toString")).toBe(false);
    });
  });
});
describe("normalizePubkey fuzz", () => {
  describe("prototype pollution attempts", () => {
    it("throws for __proto__", () => {
      expect(() => normalizePubkey("__proto__")).toThrow();
    });
    it("throws for constructor", () => {
      expect(() => normalizePubkey("constructor")).toThrow();
    });
    it("throws for prototype", () => {
      expect(() => normalizePubkey("prototype")).toThrow();
    });
  });
  describe("case sensitivity", () => {
    it("normalizes uppercase to lowercase", () => {
      const upper = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
      const lower = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      expect(normalizePubkey(upper)).toBe(lower);
    });
    it("normalizes mixed case to lowercase", () => {
      const mixed = "0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf";
      const lower = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      expect(normalizePubkey(mixed)).toBe(lower);
    });
  });
});
describe("SeenTracker fuzz", () => {
  describe("malformed IDs", () => {
    it("handles empty string IDs", () => {
      const tracker = createSeenTracker({ maxEntries: 100 });
      expect(() => tracker.add("")).not.toThrow();
      expect(tracker.peek("")).toBe(true);
      tracker.stop();
    });
    it("handles very long IDs", () => {
      const tracker = createSeenTracker({ maxEntries: 100 });
      const longId = "a".repeat(1e5);
      expect(() => tracker.add(longId)).not.toThrow();
      expect(tracker.peek(longId)).toBe(true);
      tracker.stop();
    });
    it("handles unicode IDs", () => {
      const tracker = createSeenTracker({ maxEntries: 100 });
      const unicodeId = "\u4E8B\u4EF6ID_\u{1F389}_\u0442\u0435\u0441\u0442";
      expect(() => tracker.add(unicodeId)).not.toThrow();
      expect(tracker.peek(unicodeId)).toBe(true);
      tracker.stop();
    });
    it("handles IDs with null bytes", () => {
      const tracker = createSeenTracker({ maxEntries: 100 });
      const idWithNull = "event\0id";
      expect(() => tracker.add(idWithNull)).not.toThrow();
      expect(tracker.peek(idWithNull)).toBe(true);
      tracker.stop();
    });
    it("handles prototype property names as IDs", () => {
      const tracker = createSeenTracker({ maxEntries: 100 });
      expect(() => tracker.add("__proto__")).not.toThrow();
      expect(() => tracker.add("constructor")).not.toThrow();
      expect(() => tracker.add("toString")).not.toThrow();
      expect(() => tracker.add("hasOwnProperty")).not.toThrow();
      expect(tracker.peek("__proto__")).toBe(true);
      expect(tracker.peek("constructor")).toBe(true);
      expect(tracker.peek("toString")).toBe(true);
      expect(tracker.peek("hasOwnProperty")).toBe(true);
      tracker.stop();
    });
  });
  describe("rapid operations", () => {
    it("handles rapid add/check cycles", () => {
      const tracker = createSeenTracker({ maxEntries: 1e3 });
      for (let i = 0; i < 1e4; i++) {
        const id = `event-${i}`;
        tracker.add(id);
        if (i < 1e3) {
          tracker.peek(id);
        }
      }
      expect(tracker.size()).toBeLessThanOrEqual(1e3);
      tracker.stop();
    });
    it("handles concurrent-style operations", () => {
      const tracker = createSeenTracker({ maxEntries: 100 });
      for (let i = 0; i < 100; i++) {
        tracker.add(`add-${i}`);
        tracker.peek(`peek-${i}`);
        tracker.has(`has-${i}`);
        if (i % 10 === 0) {
          tracker.delete(`add-${i - 5}`);
        }
      }
      expect(() => tracker.size()).not.toThrow();
      tracker.stop();
    });
  });
  describe("seed edge cases", () => {
    it("handles empty seed array", () => {
      const tracker = createSeenTracker({ maxEntries: 100 });
      expect(() => tracker.seed([])).not.toThrow();
      expect(tracker.size()).toBe(0);
      tracker.stop();
    });
    it("handles seed with duplicate IDs", () => {
      const tracker = createSeenTracker({ maxEntries: 100 });
      tracker.seed(["id1", "id1", "id1", "id2", "id2"]);
      expect(tracker.size()).toBe(2);
      tracker.stop();
    });
    it("handles seed larger than maxEntries", () => {
      const tracker = createSeenTracker({ maxEntries: 5 });
      const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
      tracker.seed(ids);
      expect(tracker.size()).toBeLessThanOrEqual(5);
      tracker.stop();
    });
  });
});
describe("Metrics fuzz", () => {
  describe("invalid metric names", () => {
    it("handles unknown metric names gracefully", () => {
      const metrics = createMetrics();
      expect(() => {
        metrics.emit("invalid.metric.name");
      }).not.toThrow();
    });
  });
  describe("invalid label values", () => {
    it("handles null relay label", () => {
      const metrics = createMetrics();
      expect(() => {
        metrics.emit("relay.connect", 1, { relay: null });
      }).not.toThrow();
    });
    it("handles undefined relay label", () => {
      const metrics = createMetrics();
      expect(() => {
        metrics.emit("relay.connect", 1, { relay: void 0 });
      }).not.toThrow();
    });
    it("handles very long relay URL", () => {
      const metrics = createMetrics();
      const longUrl = "wss://" + "a".repeat(1e4) + ".com";
      expect(() => {
        metrics.emit("relay.connect", 1, { relay: longUrl });
      }).not.toThrow();
      const snapshot = metrics.getSnapshot();
      expect(snapshot.relays[longUrl]).toBeDefined();
    });
  });
  describe("extreme values", () => {
    it("handles NaN value", () => {
      const metrics = createMetrics();
      expect(() => metrics.emit("event.received", NaN)).not.toThrow();
      const snapshot = metrics.getSnapshot();
      expect(isNaN(snapshot.eventsReceived)).toBe(true);
    });
    it("handles Infinity value", () => {
      const metrics = createMetrics();
      expect(() => metrics.emit("event.received", Infinity)).not.toThrow();
      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(Infinity);
    });
    it("handles negative value", () => {
      const metrics = createMetrics();
      metrics.emit("event.received", -1);
      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(-1);
    });
    it("handles very large value", () => {
      const metrics = createMetrics();
      metrics.emit("event.received", Number.MAX_SAFE_INTEGER);
      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
  describe("rapid emissions", () => {
    it("handles many rapid emissions", () => {
      const events = [];
      const metrics = createMetrics((e) => events.push(e));
      for (let i = 0; i < 1e4; i++) {
        metrics.emit("event.received");
      }
      expect(events).toHaveLength(1e4);
      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(1e4);
    });
  });
  describe("reset during operation", () => {
    it("handles reset mid-operation safely", () => {
      const metrics = createMetrics();
      metrics.emit("event.received");
      metrics.emit("event.received");
      metrics.reset();
      metrics.emit("event.received");
      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(1);
    });
  });
});
describe("Event shape validation", () => {
  describe("malformed event structures", () => {
    it("identifies missing required fields", () => {
      const malformedEvents = [
        {},
        // empty
        { id: "abc" },
        // missing pubkey, created_at, etc.
        { id: null, pubkey: null },
        // null values
        { id: 123, pubkey: 456 },
        // wrong types
        { tags: "not-an-array" },
        // wrong type for tags
        { tags: [[1, 2, 3]] }
        // wrong type for tag elements
      ];
      for (const event of malformedEvents) {
        const hasId = typeof event?.id === "string";
        const hasPubkey = typeof event?.pubkey === "string";
        const hasTags = Array.isArray(event?.tags);
        expect(hasId && hasPubkey && hasTags).toBe(false);
      }
    });
  });
  describe("timestamp edge cases", () => {
    const testTimestamps = [
      { value: NaN, desc: "NaN" },
      { value: Infinity, desc: "Infinity" },
      { value: -Infinity, desc: "-Infinity" },
      { value: -1, desc: "negative" },
      { value: 0, desc: "zero" },
      { value: 253402300800, desc: "year 10000" },
      // Far future
      { value: -62135596800, desc: "year 0001" },
      // Far past
      { value: 1.5, desc: "float" }
    ];
    for (const { value, desc } of testTimestamps) {
      it(`handles ${desc} timestamp`, () => {
        const isValidTimestamp = typeof value === "number" && !isNaN(value) && isFinite(value) && value >= 0 && Number.isInteger(value);
        if (["NaN", "Infinity", "-Infinity", "negative", "float"].includes(desc)) {
          expect(isValidTimestamp).toBe(false);
        }
      });
    }
  });
});
describe("JSON parsing edge cases", () => {
  const malformedJsonCases = [
    { input: "", desc: "empty string" },
    { input: "null", desc: "null literal" },
    { input: "undefined", desc: "undefined literal" },
    { input: "{", desc: "incomplete object" },
    { input: "[", desc: "incomplete array" },
    { input: '{"key": undefined}', desc: "undefined value" },
    { input: "{'key': 'value'}", desc: "single quotes" },
    { input: '{"key": NaN}', desc: "NaN value" },
    { input: '{"key": Infinity}', desc: "Infinity value" },
    { input: "\0", desc: "null byte" },
    { input: "abc", desc: "plain string" },
    { input: "123", desc: "plain number" }
  ];
  for (const { input, desc } of malformedJsonCases) {
    it(`handles malformed JSON: ${desc}`, () => {
      let parsed;
      let parseError = false;
      try {
        parsed = JSON.parse(input);
      } catch {
        parseError = true;
      }
      if (!parseError) {
        const isValidRelayMessage = Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[0] === "string";
        if (["null literal", "plain number", "plain string"].includes(desc)) {
          expect(isValidRelayMessage).toBe(false);
        }
      }
    });
  }
});
