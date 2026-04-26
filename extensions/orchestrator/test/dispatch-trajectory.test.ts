import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dispatchTask } from "../src/dispatch.js";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.config-default.js";
import type { CompiledRoutingConfig } from "../src/routing.js";
import { createStore } from "../src/store.js";
import {
  __resetRecorderRegistry,
  getRecorder,
  type TaskTrajectoryEvent,
  type TaskTrajectoryEventType,
} from "../src/trajectory.js";

let tmpHome: string;
let agentsDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "orchestrator-dispatch-traj-"));
  agentsDir = join(tmpHome, "agents");
  sessionFile = join(tmpHome, "sessions", "abc123.jsonl");
  __resetRecorderRegistry();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  __resetRecorderRegistry();
});

function compile(): CompiledRoutingConfig {
  return {
    schemaVersion: 1,
    rules: DEFAULT_ROUTING_CONFIG.rules.map((rule) => ({
      ...rule,
      regex: new RegExp(rule.pattern, "i"),
    })),
    default: DEFAULT_ROUTING_CONFIG.default,
    approvalRequired: DEFAULT_ROUTING_CONFIG.approvalRequired,
    approvalRequiredCapabilities: DEFAULT_ROUTING_CONFIG.approvalRequiredCapabilities,
  };
}

function readEvents(path: string): TaskTrajectoryEvent[] {
  const text = readFileSync(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TaskTrajectoryEvent);
}

describe("dispatchTask + trajectory recorder", () => {
  test("synthetic mode emits queued -> assigned -> in_progress -> awaiting_approval for an approval-required agent", () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    const queued = store.submit({
      goal: "fix this bug",
      submittedBy: "tester",
    });

    dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
      recorder,
    });

    const events = readEvents(recorder.sidecarPath);
    expect(events.map((e) => e.type)).toEqual<TaskTrajectoryEventType[]>([
      "task.queued",
      "task.assigned",
      "task.in_progress",
      "task.awaiting_approval",
    ]);
    for (const event of events) {
      expect(event.data.taskId).toBe(queued.id);
    }
  });

  test("synthetic mode emits task.done (not awaiting_approval) for non-gated agents", () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    const queued = store.submit({
      goal: "research the literature",
      submittedBy: "tester",
    });

    dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
      recorder,
    });

    const events = readEvents(recorder.sidecarPath);
    expect(events.map((e) => e.type)).toContain("task.done");
    expect(events.map((e) => e.type)).not.toContain("task.awaiting_approval");
  });

  test("shadow mode emits queued + assigned only (spawn-watch will emit the rest)", () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    const queued = store.submit({
      goal: "design the new ui",
      submittedBy: "tester",
      kind: "shadow",
    });

    dispatchTask(queued, store, {
      config: compile(),
      mode: "shadow",
      agentsDir,
      recorder,
    });

    const events = readEvents(recorder.sidecarPath);
    expect(events.map((e) => e.type)).toEqual<TaskTrajectoryEventType[]>([
      "task.queued",
      "task.assigned",
    ]);
  });

  test("recorder is optional — dispatch without one runs cleanly", () => {
    const store = createStore({ openclawHome: tmpHome });
    const queued = store.submit({
      goal: "research X",
      submittedBy: "tester",
    });
    expect(() =>
      dispatchTask(queued, store, {
        config: compile(),
        mode: "synthetic",
        agentsDir,
      }),
    ).not.toThrow();
  });

  test("seq is monotonic across the synthetic round-trip", () => {
    const store = createStore({ openclawHome: tmpHome });
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    const queued = store.submit({
      goal: "fix this bug",
      submittedBy: "tester",
    });
    dispatchTask(queued, store, {
      config: compile(),
      mode: "synthetic",
      agentsDir,
      recorder,
    });
    const events = readEvents(recorder.sidecarPath);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});
