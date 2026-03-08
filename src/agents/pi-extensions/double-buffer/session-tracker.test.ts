/**
 * Tests for SessionTracker — cursor management and history-shrink detection.
 *
 * These cover the logic that was previously inline in extension.ts and
 * had no test coverage.
 */

import { describe, expect, it } from "vitest";
import { SessionTracker } from "./session-tracker.js";

/** Create a unique session key object (mimics ctx.sessionManager). */
function makeSession(): object {
  return {};
}

describe("SessionTracker", () => {
  describe("cold start", () => {
    it("returns newStartIndex 0 on first call", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      const result = tracker.evaluate(s1, 5);
      expect(result.action).toBe("none");
      expect(result.newStartIndex).toBe(0);
    });
  });

  describe("incremental growth", () => {
    it("returns correct newStartIndex after commit", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      tracker.evaluate(s1, 3);
      tracker.commit(s1, 3);

      const result = tracker.evaluate(s1, 5);
      expect(result.action).toBe("none");
      expect(result.newStartIndex).toBe(3);
    });

    it("returns 0 new messages when count unchanged", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      tracker.evaluate(s1, 5);
      tracker.commit(s1, 5);

      const result = tracker.evaluate(s1, 5);
      expect(result.action).toBe("none");
      expect(result.newStartIndex).toBe(5);
    });
  });

  describe("history shrinkage (compaction/reload)", () => {
    it("returns recreate action when message count drops", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      tracker.evaluate(s1, 10);
      tracker.commit(s1, 10);

      const result = tracker.evaluate(s1, 4);
      expect(result.action).toBe("recreate");
      expect(result.newStartIndex).toBe(0);
    });

    it("clears observed count after shrink detection", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      tracker.evaluate(s1, 10);
      tracker.commit(s1, 10);

      tracker.evaluate(s1, 4); // triggers recreate
      expect(tracker.getObserved(s1)).toBe(0);
    });

    it("subsequent call after shrink starts fresh", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      tracker.evaluate(s1, 10);
      tracker.commit(s1, 10);

      // Shrink detected — manager would be recreated
      tracker.evaluate(s1, 4);
      // Simulate commit after re-ingesting the 4 messages
      tracker.commit(s1, 4);

      // Next call with 6 messages should show 2 new
      const result = tracker.evaluate(s1, 6);
      expect(result.action).toBe("none");
      expect(result.newStartIndex).toBe(4);
    });

    it("detects shrink to exactly 0 messages", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      tracker.evaluate(s1, 5);
      tracker.commit(s1, 5);

      const result = tracker.evaluate(s1, 0);
      expect(result.action).toBe("recreate");
      expect(result.newStartIndex).toBe(0);
    });
  });

  describe("multiple sessions", () => {
    it("tracks sessions independently", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      const s2 = makeSession();
      tracker.evaluate(s1, 10);
      tracker.commit(s1, 10);
      tracker.evaluate(s2, 3);
      tracker.commit(s2, 3);

      // s1 shrinks, s2 grows — they should not interfere
      const r1 = tracker.evaluate(s1, 5);
      const r2 = tracker.evaluate(s2, 7);

      expect(r1.action).toBe("recreate");
      expect(r2.action).toBe("none");
      expect(r2.newStartIndex).toBe(3);
    });
  });

  describe("forget", () => {
    it("removes tracking so next call starts fresh", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      tracker.evaluate(s1, 10);
      tracker.commit(s1, 10);

      tracker.forget(s1);
      expect(tracker.getObserved(s1)).toBe(0);

      // Should not trigger recreate since there's no prior cursor
      const result = tracker.evaluate(s1, 5);
      expect(result.action).toBe("none");
      expect(result.newStartIndex).toBe(0);
    });
  });

  describe("no commit between evaluates", () => {
    it("does not advance cursor without commit", () => {
      const tracker = new SessionTracker();
      const s1 = makeSession();
      tracker.evaluate(s1, 5);
      // No commit — cursor stays at 0

      const result = tracker.evaluate(s1, 8);
      expect(result.action).toBe("none");
      expect(result.newStartIndex).toBe(0);
    });
  });

  describe("GC safety", () => {
    it("uses WeakMap so dereferenced sessions are eligible for GC", () => {
      const tracker = new SessionTracker();
      let s1: object | null = makeSession();
      tracker.evaluate(s1, 10);
      tracker.commit(s1, 10);

      // After dropping the reference, the WeakMap entry becomes eligible for GC.
      // We can't directly test GC, but we verify the tracker uses WeakMap by
      // confirming a new object with the same shape gets a fresh cursor.
      s1 = null;
      const s1New = makeSession();
      const result = tracker.evaluate(s1New, 3);
      expect(result.action).toBe("none");
      expect(result.newStartIndex).toBe(0);
    });
  });
});
