import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.config-default.js";
import {
  createSyntheticHarness,
  loadSyntheticFixtures,
  summariseRunResults,
} from "../src/synthetic.js";

let tmpRoot: string;
let routingPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orchestrator-synthetic-"));
  routingPath = join(tmpRoot, "routing.json");
  writeFileSync(routingPath, JSON.stringify(DEFAULT_ROUTING_CONFIG, null, 2));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadSyntheticFixtures", () => {
  test("ships a fixture file with five entries", () => {
    const fixtures = loadSyntheticFixtures();
    expect(fixtures.schemaVersion).toBe(1);
    expect(fixtures.fixtures.length).toBe(5);
    const labels = fixtures.fixtures.map((f) => f.label);
    expect(labels).toContain("code-1");
    expect(labels).toContain("ops-1");
    expect(labels).toContain("research-1");
    expect(labels).toContain("writing-1");
    expect(labels).toContain("fallback-1");
  });

  test("rejects malformed schemaVersion", () => {
    const bad = join(tmpRoot, "bad.json");
    writeFileSync(bad, JSON.stringify({ schemaVersion: 99, fixtures: [] }));
    expect(() => loadSyntheticFixtures(bad)).toThrow(/malformed/);
  });
});

describe("createSyntheticHarness", () => {
  test("run('code-1') routes to coder and lands at awaiting_approval", () => {
    const harness = createSyntheticHarness({
      openclawHome: tmpRoot,
      routingPath,
    });
    const result = harness.run("code-1");
    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("coder");
    expect(result.ruleId).toBe("code-tasks");
    expect(result.state).toBe("awaiting_approval");
  });

  test("run('research-1') routes to researcher and goes straight to done", () => {
    const harness = createSyntheticHarness({
      openclawHome: tmpRoot,
      routingPath,
    });
    const result = harness.run("research-1");
    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("researcher");
    expect(result.state).toBe("done");
  });

  test("run('fallback-1') reports default-route fallback to main", () => {
    const harness = createSyntheticHarness({
      openclawHome: tmpRoot,
      routingPath,
    });
    const result = harness.run("fallback-1");
    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("main");
    expect(result.ruleId).toBeNull();
  });

  test("run() on an unknown label throws", () => {
    const harness = createSyntheticHarness({
      openclawHome: tmpRoot,
      routingPath,
    });
    expect(() => harness.run("does-not-exist")).toThrow(/unknown synthetic fixture/);
  });

  test("runAll() executes every fixture in order", () => {
    const harness = createSyntheticHarness({
      openclawHome: tmpRoot,
      routingPath,
    });
    const results = harness.runAll();
    expect(results.map((r) => r.label)).toEqual([
      "code-1",
      "ops-1",
      "research-1",
      "writing-1",
      "fallback-1",
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("runAll() persists each task to the synthetic dir, not live", () => {
    const harness = createSyntheticHarness({
      openclawHome: tmpRoot,
      routingPath,
    });
    harness.runAll();
    // Live list should be empty; synthetic kind should hold all 5.
    expect(harness.store.list({ kind: "live" }).length).toBe(0);
    expect(harness.store.list({ kind: "synthetic" }).length).toBe(5);
  });

  test("runAll() invokes the optional recorder for each fixture", () => {
    const recorded: string[] = [];
    const harness = createSyntheticHarness({
      openclawHome: tmpRoot,
      routingPath,
      makeRecorder: () => ({
        get sidecarPath() {
          return resolve(tmpRoot, "fake.tasks.jsonl");
        },
        get currentSeq() {
          return 0;
        },
        record(type) {
          recorded.push(type);
          return {
            traceSchema: "openclaw-trajectory",
            schemaVersion: 1,
            traceId: "x",
            source: "runtime",
            type,
            ts: new Date().toISOString(),
            seq: 1,
            sessionId: "x",
            data: { kind: "queued", taskId: "T", goal: "g", submittedBy: "u" },
          };
        },
      }),
    });
    harness.runAll();
    // Each fixture emits at least 4 events (queued, assigned, in_progress, done|awaiting_approval).
    expect(recorded.length).toBeGreaterThanOrEqual(20);
    expect(new Set(recorded)).toContain("task.queued");
    expect(new Set(recorded)).toContain("task.assigned");
  });
});

describe("summariseRunResults", () => {
  test("renders pass count and per-fixture lines", () => {
    const out = summariseRunResults([
      {
        label: "x",
        taskId: "T",
        state: "done",
        agentId: "main",
        ruleId: null,
        ok: true,
        reason: null,
      },
      {
        label: "y",
        taskId: "T2",
        state: "failed",
        agentId: "coder",
        ruleId: "code-tasks",
        ok: false,
        reason: "expected state=done, got failed",
      },
    ]);
    expect(out).toContain("1/2 fixtures passed");
    const lines = out.split("\n");
    expect(lines.some((l) => l.includes("ok") && l.includes("x"))).toBe(true);
    expect(lines.some((l) => l.includes("FAIL") && l.includes("y"))).toBe(true);
    expect(out).toContain("expected state=done");
  });
});
