import { describe, expect, it, beforeEach } from "vitest";
import {
  __testing,
  pushSessionCoalesceEntry,
  drainSessionCoalesceEntries,
  isCoalesceTokenPending,
  mergeCoalescedEntries,
  getSessionCoalesceBufferSize,
  type SessionCoalesceEntry,
} from "./pi-embedded-runner/session-coalesce.js";

beforeEach(() => {
  __testing.resetBuffers();
});

describe("pushSessionCoalesceEntry", () => {
  it("returns a unique token for each push", () => {
    const t1 = pushSessionCoalesceEntry("s1", { prompt: "a" });
    const t2 = pushSessionCoalesceEntry("s1", { prompt: "b" });
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    expect(t1).not.toBe(t2);
  });

  it("increments buffer size", () => {
    expect(getSessionCoalesceBufferSize("s1")).toBe(0);
    pushSessionCoalesceEntry("s1", { prompt: "a" });
    expect(getSessionCoalesceBufferSize("s1")).toBe(1);
    pushSessionCoalesceEntry("s1", { prompt: "b" });
    expect(getSessionCoalesceBufferSize("s1")).toBe(2);
  });

  it("isolates buffers per session key", () => {
    pushSessionCoalesceEntry("s1", { prompt: "a" });
    pushSessionCoalesceEntry("s2", { prompt: "b" });
    expect(getSessionCoalesceBufferSize("s1")).toBe(1);
    expect(getSessionCoalesceBufferSize("s2")).toBe(1);
  });
});

describe("drainSessionCoalesceEntries", () => {
  it("returns all entries and clears the buffer", () => {
    pushSessionCoalesceEntry("s1", { prompt: "a" });
    pushSessionCoalesceEntry("s1", { prompt: "b" });

    const drained = drainSessionCoalesceEntries("s1");
    expect(drained).toHaveLength(2);
    expect(drained[0].prompt).toBe("a");
    expect(drained[1].prompt).toBe("b");
    expect(getSessionCoalesceBufferSize("s1")).toBe(0);
  });

  it("returns empty array when buffer is empty", () => {
    expect(drainSessionCoalesceEntries("nonexistent")).toEqual([]);
  });

  it("subsequent drain returns empty after first drain", () => {
    pushSessionCoalesceEntry("s1", { prompt: "a" });
    drainSessionCoalesceEntries("s1");
    expect(drainSessionCoalesceEntries("s1")).toEqual([]);
  });
});

describe("isCoalesceTokenPending", () => {
  it("returns true for a pending token", () => {
    const token = pushSessionCoalesceEntry("s1", { prompt: "a" });
    expect(isCoalesceTokenPending("s1", token)).toBe(true);
  });

  it("returns false after drain", () => {
    const token = pushSessionCoalesceEntry("s1", { prompt: "a" });
    drainSessionCoalesceEntries("s1");
    expect(isCoalesceTokenPending("s1", token)).toBe(false);
  });

  it("returns false for non-existent session", () => {
    expect(isCoalesceTokenPending("nope", "fake")).toBe(false);
  });
});

describe("mergeCoalescedEntries", () => {
  const makeEntry = (
    prompt: string,
    images?: SessionCoalesceEntry["images"],
  ): SessionCoalesceEntry => ({
    token: `t-${prompt}`,
    prompt,
    images,
    pushedAt: Date.now(),
  });

  it("returns empty prompt for empty array", () => {
    const result = mergeCoalescedEntries([]);
    expect(result.prompt).toBe("");
    expect(result.images).toBeUndefined();
  });

  it("returns single entry as-is", () => {
    const entry = makeEntry("hello", [{ type: "image", mimeType: "image/png", data: "abc" }]);
    const result = mergeCoalescedEntries([entry]);
    expect(result.prompt).toBe("hello");
    expect(result.images).toHaveLength(1);
  });

  it("merges multiple prompts with double newline separator", () => {
    const entries = [makeEntry("first"), makeEntry("second"), makeEntry("third")];
    const result = mergeCoalescedEntries(entries);
    expect(result.prompt).toBe("first\n\nsecond\n\nthird");
  });

  it("merges images from all entries", () => {
    const img1 = { type: "image" as const, mimeType: "image/png", data: "a" };
    const img2 = { type: "image" as const, mimeType: "image/jpeg", data: "b" };
    const entries = [makeEntry("x", [img1]), makeEntry("y", [img2])];
    const result = mergeCoalescedEntries(entries);
    expect(result.images).toHaveLength(2);
  });

  it("skips empty prompts in merge", () => {
    const entries = [makeEntry("first"), makeEntry("  "), makeEntry("third")];
    const result = mergeCoalescedEntries(entries);
    expect(result.prompt).toBe("first\n\nthird");
  });

  it("returns undefined images when no entries have images", () => {
    const entries = [makeEntry("a"), makeEntry("b")];
    const result = mergeCoalescedEntries(entries);
    expect(result.images).toBeUndefined();
  });
});

describe("coalescing flow simulation", () => {
  it("first task drains all accumulated entries, second task gets empty", () => {
    // Simulate: message A pushed, message B pushed, then A's task acquires lane and drains.
    const tokenA = pushSessionCoalesceEntry("s1", { prompt: "msgA" });
    const tokenB = pushSessionCoalesceEntry("s1", { prompt: "msgB" });

    // Task A acquires session lane → drains buffer
    const drainedByA = drainSessionCoalesceEntries("s1");
    expect(drainedByA).toHaveLength(2);
    expect(drainedByA[0].token).toBe(tokenA);
    expect(drainedByA[1].token).toBe(tokenB);

    // Task B acquires session lane → buffer is empty
    const drainedByB = drainSessionCoalesceEntries("s1");
    expect(drainedByB).toHaveLength(0);
  });

  it("entries pushed after drain are not lost", () => {
    pushSessionCoalesceEntry("s1", { prompt: "early" });
    drainSessionCoalesceEntries("s1");

    // New message arrives while task A is in global lane
    pushSessionCoalesceEntry("s1", { prompt: "late" });
    const drained = drainSessionCoalesceEntries("s1");
    expect(drained).toHaveLength(1);
    expect(drained[0].prompt).toBe("late");
  });
});
