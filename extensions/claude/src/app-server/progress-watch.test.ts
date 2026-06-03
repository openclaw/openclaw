import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeProgressWatch } from "./progress-watch.js";

describe("createClaudeProgressWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(overrides: Record<string, unknown> = {}) {
    let settled = false;
    const stalls: Array<{ idleMs: number; openItems: number }> = [];
    const watch = createClaudeProgressWatch({
      timeoutMs: 1000,
      isSettled: () => settled,
      onStall: (info) => stalls.push(info),
      ...overrides,
    });
    return {
      watch,
      stalls,
      settle: () => {
        settled = true;
      },
    };
  }

  it("fires a stall after the timeout with no activity and no open items", () => {
    const h = make();
    h.watch.arm();
    vi.advanceTimersByTime(999);
    expect(h.stalls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.stalls).toHaveLength(1);
    expect(h.stalls[0]).toMatchObject({ openItems: 0 });
    expect(h.stalls[0].idleMs).toBeGreaterThanOrEqual(1000);
  });

  it("noteProgress resets the deadline so no stall fires while real activity flows", () => {
    const h = make();
    h.watch.arm();
    // Real activity every 900ms keeps the 1000ms watch alive indefinitely.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(900);
      h.watch.noteProgress();
    }
    expect(h.stalls).toHaveLength(0);
    // Once activity stops, it fires exactly one window later.
    vi.advanceTimersByTime(1000);
    expect(h.stalls).toHaveLength(1);
  });

  it("a periodic keepalive that is NOT mapped to the watch does not delay the stall", () => {
    // The caller intentionally does not call noteProgress() for kind:"heartbeat",
    // so a heartbeating-but-silent turn still stalls on schedule.
    const h = make();
    h.watch.arm();
    vi.advanceTimersByTime(1000);
    expect(h.stalls).toHaveLength(1);
  });

  it("suppresses the stall while a turn item is in flight, then fires after it completes", () => {
    const h = make();
    h.watch.arm();
    h.watch.noteItemStarted();
    vi.advanceTimersByTime(5000); // far past the window, but an item is open
    expect(h.stalls).toHaveLength(0);
    h.watch.noteItemCompleted();
    vi.advanceTimersByTime(999);
    expect(h.stalls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.stalls).toHaveLength(1);
    expect(h.stalls[0]).toMatchObject({ openItems: 0 });
  });

  it("requires all nested open items to complete before a stall can fire", () => {
    const h = make();
    h.watch.arm();
    h.watch.noteItemStarted();
    h.watch.noteItemStarted(); // e.g. two parallel tool calls
    h.watch.noteItemCompleted();
    vi.advanceTimersByTime(5000);
    expect(h.stalls).toHaveLength(0); // one still open
    h.watch.noteItemCompleted();
    vi.advanceTimersByTime(1000);
    expect(h.stalls).toHaveLength(1);
  });

  it("does not fire once settled", () => {
    const h = make();
    h.watch.arm();
    h.settle();
    vi.advanceTimersByTime(10_000);
    expect(h.stalls).toHaveLength(0);
  });

  it("dispose stops the watch", () => {
    const h = make();
    h.watch.arm();
    h.watch.dispose();
    vi.advanceTimersByTime(10_000);
    expect(h.stalls).toHaveLength(0);
  });

  it("does not busy-reschedule while an item stays open for a long time", () => {
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const h = make();
    h.watch.arm();
    h.watch.noteItemStarted();
    const before = setSpy.mock.calls.length;
    vi.advanceTimersByTime(10_000); // 10 windows with the item open
    // Should re-arm ~once per window (10), not once per millisecond.
    expect(setSpy.mock.calls.length - before).toBeLessThan(20);
    expect(h.stalls).toHaveLength(0);
    setSpy.mockRestore();
  });
});
