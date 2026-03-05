import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ActivityLogStore } from "../../src/core/activity-log-store.js";
import type { ActivityEntry, ActivityCategory } from "../../src/core/activity-log-store.js";

describe("ActivityLogStore", () => {
  let store: ActivityLogStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "activity-log-test-"));
    store = new ActivityLogStore(join(tmpDir, "test-activity.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends and retrieves entries", () => {
    const entry = store.append({
      category: "promotion",
      action: "promote_l1_to_l2",
      strategyId: "strat-1",
      detail: "Auto-promoted to L2",
    });

    expect(entry.id).toMatch(/^act-\d+-/);
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.category).toBe("promotion");
    expect(entry.strategyId).toBe("strat-1");
  });

  it("listRecent returns newest first", () => {
    store.append({ category: "wake", action: "a1", detail: "first" });
    store.append({ category: "promotion", action: "a2", detail: "second" });
    store.append({ category: "demotion", action: "a3", detail: "third" });

    const recent = store.listRecent(10);
    expect(recent.length).toBe(3);
    expect(recent[0].detail).toBe("third");
    expect(recent[2].detail).toBe("first");
  });

  it("listRecent filters by category", () => {
    store.append({ category: "wake", action: "a1", detail: "w1" });
    store.append({ category: "promotion", action: "a2", detail: "p1" });
    store.append({ category: "wake", action: "a3", detail: "w2" });

    const wakeOnly = store.listRecent(10, "wake");
    expect(wakeOnly.length).toBe(2);
    expect(wakeOnly.every((e) => e.category === "wake")).toBe(true);
  });

  it("listRecent respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.append({ category: "heartbeat", action: `hb-${i}`, detail: `beat ${i}` });
    }
    const limited = store.listRecent(3);
    expect(limited.length).toBe(3);
  });

  it("get retrieves by id", () => {
    const entry = store.append({
      category: "error",
      action: "cycle_error",
      detail: "something failed",
    });
    const found = store.get(entry.id);
    expect(found).toBeDefined();
    expect(found!.action).toBe("cycle_error");
  });

  it("get returns undefined for unknown id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("persists and reloads from disk", () => {
    store.append({ category: "seed", action: "seed_done", detail: "seeded 5" });
    store.append({ category: "approval", action: "approved", detail: "approved strat" });
    store.close();

    // Reopen — reassign so afterEach closes the new instance
    store = new ActivityLogStore(join(tmpDir, "test-activity.sqlite"));
    const entries = store.listRecent(10);
    expect(entries.length).toBe(2);
    expect(entries[0].category).toBe("approval");
  });

  it("stores and retrieves metadata", () => {
    const entry = store.append({
      category: "promotion",
      action: "promote",
      detail: "promoted",
      metadata: { from: "L1", to: "L2", reasons: ["sharpe ok"] },
    });

    const found = store.get(entry.id);
    expect(found!.metadata).toEqual({ from: "L1", to: "L2", reasons: ["sharpe ok"] });
  });

  it("subscribe receives new entries", () => {
    const received: ActivityEntry[] = [];
    const unsub = store.subscribe((e) => received.push(e));

    store.append({ category: "wake", action: "wake1", detail: "test" });
    store.append({ category: "error", action: "err1", detail: "fail" });

    expect(received.length).toBe(2);
    expect(received[0].category).toBe("wake");
    expect(received[1].category).toBe("error");

    unsub();
    store.append({ category: "heartbeat", action: "hb", detail: "after unsub" });
    expect(received.length).toBe(2); // no more after unsub
  });

  it("trims entries beyond MAX_ENTRIES", () => {
    // MAX_ENTRIES is 500, add 510
    for (let i = 0; i < 510; i++) {
      store.append({ category: "heartbeat", action: `hb-${i}`, detail: `beat ${i}` });
    }
    const all = store.listRecent(600);
    expect(all.length).toBeLessThanOrEqual(500);
  });
});
