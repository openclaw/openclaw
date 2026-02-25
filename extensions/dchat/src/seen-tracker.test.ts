import { describe, expect, it } from "vitest";
import { SeenTracker } from "./seen-tracker.js";

describe("SeenTracker", () => {
  it("tracks seen message IDs", () => {
    const tracker = new SeenTracker();
    expect(tracker.hasSeen("msg-1")).toBe(false);
    tracker.markSeen("msg-1");
    expect(tracker.hasSeen("msg-1")).toBe(true);
  });

  it("checkAndMark returns false for new, true for seen", () => {
    const tracker = new SeenTracker();
    expect(tracker.checkAndMark("msg-1")).toBe(false);
    expect(tracker.checkAndMark("msg-1")).toBe(true);
    expect(tracker.checkAndMark("msg-2")).toBe(false);
  });

  it("tracks size correctly", () => {
    const tracker = new SeenTracker();
    expect(tracker.size).toBe(0);
    tracker.markSeen("a");
    tracker.markSeen("b");
    tracker.markSeen("c");
    expect(tracker.size).toBe(3);
  });

  it("evicts oldest entries when over capacity", () => {
    const tracker = new SeenTracker(3);
    tracker.markSeen("a");
    tracker.markSeen("b");
    tracker.markSeen("c");
    expect(tracker.size).toBe(3);

    // Adding a 4th should evict "a" (oldest)
    tracker.markSeen("d");
    expect(tracker.size).toBe(3);
    expect(tracker.hasSeen("a")).toBe(false);
    expect(tracker.hasSeen("b")).toBe(true);
    expect(tracker.hasSeen("c")).toBe(true);
    expect(tracker.hasSeen("d")).toBe(true);
  });

  it("re-marking refreshes position (LRU behavior)", () => {
    const tracker = new SeenTracker(3);
    tracker.markSeen("a");
    tracker.markSeen("b");
    tracker.markSeen("c");

    // Re-mark "a" to move it to the end
    tracker.markSeen("a");

    // Now "b" is oldest; adding "d" should evict "b"
    tracker.markSeen("d");
    expect(tracker.hasSeen("b")).toBe(false);
    expect(tracker.hasSeen("a")).toBe(true);
    expect(tracker.hasSeen("c")).toBe(true);
    expect(tracker.hasSeen("d")).toBe(true);
  });

  it("clear removes all entries", () => {
    const tracker = new SeenTracker();
    tracker.markSeen("a");
    tracker.markSeen("b");
    expect(tracker.size).toBe(2);
    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(tracker.hasSeen("a")).toBe(false);
  });

  it("handles default max size of 10000", () => {
    const tracker = new SeenTracker();
    for (let i = 0; i < 10001; i++) {
      tracker.markSeen(`msg-${i}`);
    }
    expect(tracker.size).toBe(10000);
    // First entry should have been evicted
    expect(tracker.hasSeen("msg-0")).toBe(false);
    expect(tracker.hasSeen("msg-10000")).toBe(true);
  });
});
