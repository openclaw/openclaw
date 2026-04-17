import { describe, expect, it, vi } from "vitest";
import type { ShortTermRecallEntry } from "../short-term-promotion.js";
import { readDreamingShadowTouchEnabled, touchSidecarFromLightEntries } from "./dreaming-wiring.js";

describe("readDreamingShadowTouchEnabled", () => {
  it("returns false for null/undefined/non-object configs", () => {
    expect(readDreamingShadowTouchEnabled(null)).toBe(false);
    expect(readDreamingShadowTouchEnabled(undefined)).toBe(false);
    expect(readDreamingShadowTouchEnabled("on")).toBe(false);
    expect(readDreamingShadowTouchEnabled(42)).toBe(false);
  });

  it("returns false when memoryV2 is missing", () => {
    expect(readDreamingShadowTouchEnabled({})).toBe(false);
    expect(readDreamingShadowTouchEnabled({ ingest: { enabled: true } })).toBe(false);
  });

  it("returns false when dreamingShadowTouch.enabled is missing or not exactly true", () => {
    expect(readDreamingShadowTouchEnabled({ memoryV2: {} })).toBe(false);
    expect(readDreamingShadowTouchEnabled({ memoryV2: { dreamingShadowTouch: {} } })).toBe(false);
    expect(
      readDreamingShadowTouchEnabled({
        memoryV2: { dreamingShadowTouch: { enabled: false } },
      }),
    ).toBe(false);
    expect(
      readDreamingShadowTouchEnabled({
        memoryV2: { dreamingShadowTouch: { enabled: "true" } },
      }),
    ).toBe(false);
    expect(
      readDreamingShadowTouchEnabled({
        memoryV2: { dreamingShadowTouch: { enabled: 1 } },
      }),
    ).toBe(false);
  });

  it("returns true only when dreamingShadowTouch.enabled === true", () => {
    expect(
      readDreamingShadowTouchEnabled({
        memoryV2: { dreamingShadowTouch: { enabled: true } },
      }),
    ).toBe(true);
  });

  it("does not confuse itself with the deepDreaming flag", () => {
    expect(
      readDreamingShadowTouchEnabled({
        memoryV2: { deepDreaming: { enabled: true } },
      }),
    ).toBe(false);
  });
});

const baseEntry: ShortTermRecallEntry = {
  key: "k1",
  path: "memory/2026-04-16.md",
  startLine: 10,
  endLine: 20,
  source: "memory",
  snippet: "x",
  recallCount: 1,
  dailyCount: 1,
  groundedCount: 0,
  totalScore: 1,
  maxScore: 1,
  firstRecalledAt: "2026-04-16T00:00:00Z",
  lastRecalledAt: "2026-04-16T00:00:00Z",
  queryHashes: [],
  recallDays: ["2026-04-16"],
  conceptTags: [],
};

describe("touchSidecarFromLightEntries", () => {
  it("is a no-op on empty entries — does not open the db", () => {
    const openDb = vi.fn();
    const touch = vi.fn();
    touchSidecarFromLightEntries({ openDb, touch }, [], "/ws");
    expect(openDb).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it('is a no-op when no entry has source === "memory" — does not open the db', () => {
    const openDb = vi.fn();
    const touch = vi.fn();
    touchSidecarFromLightEntries(
      { openDb, touch },
      // `source` is typed as the literal "memory" today; the filter guards
      // future source expansion. Force the non-memory branch via cast.
      [{ ...baseEntry, source: "other" as unknown as "memory" }],
      "/ws",
    );
    expect(openDb).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it("passes memory entries to recordTouchedLocations with correct hits and now", () => {
    const db = {} as never;
    const openDb = vi.fn().mockReturnValue(db);
    const touch = vi.fn().mockReturnValue({ inspected: 2, inserted: 1, refreshed: 1 });
    const now = vi.fn().mockReturnValue(1234);
    touchSidecarFromLightEntries(
      { openDb, touch, now },
      [baseEntry, { ...baseEntry, key: "k2", startLine: 30, endLine: 40 }],
      "/ws",
    );
    expect(openDb).toHaveBeenCalledWith("/ws");
    expect(touch).toHaveBeenCalledTimes(1);
    const call = touch.mock.calls[0];
    expect(call?.[0]).toBe(db);
    expect(call?.[1]).toEqual([
      { source: "memory", path: "memory/2026-04-16.md", startLine: 10, endLine: 20 },
      { source: "memory", path: "memory/2026-04-16.md", startLine: 30, endLine: 40 },
    ]);
    expect(call?.[2]).toBe(1234);
  });

  it("warn-logs and does not throw when openDb throws", () => {
    const openDb = vi.fn().mockImplementation(() => {
      throw new Error("db-open-failed");
    });
    const touch = vi.fn();
    const logWarn = vi.fn();
    expect(() =>
      touchSidecarFromLightEntries({ openDb, touch, logWarn }, [baseEntry], "/ws"),
    ).not.toThrow();
    expect(touch).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[0]).toMatch(/dreaming shadow-touch failed/);
  });

  it("warn-logs and does not throw when the touch primitive throws", () => {
    const openDb = vi.fn().mockReturnValue({} as never);
    const touch = vi.fn().mockImplementation(() => {
      throw new Error("touch-failed");
    });
    const logWarn = vi.fn();
    expect(() =>
      touchSidecarFromLightEntries({ openDb, touch, logWarn }, [baseEntry], "/ws"),
    ).not.toThrow();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
