import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatShadowSummary, summariseShadow } from "../src/shadow-summary.js";
import { createStore } from "../src/store.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "orchestrator-shadow-summary-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("summariseShadow", () => {
  test("counts tasks within the window", () => {
    const store = createStore({ openclawHome: tmpHome });
    store.submit({ goal: "a", submittedBy: "t", kind: "shadow" });
    store.submit({ goal: "b", submittedBy: "t", kind: "shadow" });
    const summary = summariseShadow({ store });
    expect(summary.total).toBe(2);
    expect(summary.byState.queued).toBe(2);
  });

  test("excludes tasks created before the window horizon", () => {
    const store = createStore({ openclawHome: tmpHome });
    const old = store.submit({
      goal: "old",
      submittedBy: "t",
      kind: "shadow",
      now: () => Date.parse("2026-04-25T00:00:00.000Z"),
    });
    expect(old.createdAt).toBe("2026-04-25T00:00:00.000Z");
    store.submit({
      goal: "fresh",
      submittedBy: "t",
      kind: "shadow",
      now: () => Date.parse("2026-04-26T11:00:00.000Z"),
    });
    const summary = summariseShadow({
      store,
      windowHours: 24,
      now: () => Date.parse("2026-04-26T12:00:00.000Z"),
    });
    expect(summary.total).toBe(1);
  });

  test("counts failures separately from total", () => {
    const store = createStore({ openclawHome: tmpHome });
    const t = store.submit({
      goal: "x",
      submittedBy: "t",
      kind: "shadow",
    });
    store.transition(t.id, {
      type: "fail",
      error: { code: "specialist_aborted", message: "boom" },
    });
    const summary = summariseShadow({ store });
    expect(summary.failures).toBe(1);
    expect(summary.byState.failed).toBe(1);
  });

  test("ignores live + synthetic tasks", () => {
    const store = createStore({ openclawHome: tmpHome });
    store.submit({ goal: "live", submittedBy: "t" });
    store.submit({ goal: "synth", submittedBy: "t", kind: "synthetic" });
    store.submit({ goal: "shad", submittedBy: "t", kind: "shadow" });
    const summary = summariseShadow({ store });
    expect(summary.total).toBe(1);
  });

  test("computes mean duration over completed tasks only", () => {
    const store = createStore({ openclawHome: tmpHome });
    const t = store.submit({ goal: "x", submittedBy: "t", kind: "shadow" });
    store.transition(t.id, {
      type: "fail",
      error: { code: "specialist_timeout", message: "x" },
    });
    const summary = summariseShadow({ store });
    expect(summary.meanDurationMs).not.toBeNull();
    expect(summary.meanDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("returns zero counts when nothing has been shadowed", () => {
    const store = createStore({ openclawHome: tmpHome });
    const summary = summariseShadow({ store });
    expect(summary.total).toBe(0);
    expect(summary.failures).toBe(0);
    expect(summary.meanDurationMs).toBeNull();
  });
});

describe("formatShadowSummary", () => {
  test("renders a multiline summary with the failure count", () => {
    const text = formatShadowSummary({
      total: 5,
      byState: {
        queued: 0,
        assigned: 0,
        in_progress: 0,
        awaiting_approval: 0,
        done: 4,
        failed: 1,
        cancelled: 0,
        expired: 0,
      },
      failures: 1,
      meanDurationMs: 200,
      oldestAt: "2026-04-26T10:00:00.000Z",
      newestAt: "2026-04-26T11:00:00.000Z",
      windowHours: 24,
    });
    expect(text).toContain("total:         5");
    expect(text).toContain("failures:      1");
    expect(text).toContain("done");
    expect(text).toContain("failed");
  });
});
