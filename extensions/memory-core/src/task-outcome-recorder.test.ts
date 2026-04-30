import type { TaskRecord } from "openclaw/plugin-sdk/task-events";
import { describe, expect, it } from "vitest";
import { __testing } from "./task-outcome-recorder.js";

const { buildOutcomeRecord, shouldRecord, summarizeOutcome } = __testing;

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: overrides.taskId ?? "task-1",
    runtime: overrides.runtime ?? "subagent",
    requesterSessionKey: overrides.requesterSessionKey ?? "session:default",
    ownerKey: overrides.ownerKey ?? "owner:default",
    scopeKind: overrides.scopeKind ?? "session",
    task: overrides.task ?? "do thing",
    status: overrides.status ?? "queued",
    deliveryStatus: overrides.deliveryStatus ?? "pending",
    notifyPolicy: overrides.notifyPolicy ?? "done_only",
    createdAt: overrides.createdAt ?? 1_000,
    ...overrides,
  };
}

describe("task-outcome-recorder shouldRecord", () => {
  it("emits on first transition into a terminal state", () => {
    const event = {
      kind: "upserted" as const,
      task: makeTask({ status: "failed", error: "boom" }),
      previous: makeTask({ status: "running" }),
    };
    const result = shouldRecord(event);
    expect(result?.task.taskId).toBe("task-1");
  });

  it("ignores non-upserted events", () => {
    expect(
      shouldRecord({
        kind: "deleted",
        taskId: "task-1",
        previous: makeTask({ status: "succeeded" }),
      }),
    ).toBeNull();
    expect(shouldRecord({ kind: "restored", tasks: [makeTask({ status: "failed" })] })).toBeNull();
  });

  it("ignores upserts that stay in a non-terminal state", () => {
    expect(
      shouldRecord({
        kind: "upserted",
        task: makeTask({ status: "running" }),
        previous: makeTask({ status: "queued" }),
      }),
    ).toBeNull();
  });

  it("ignores re-emissions of an already-terminal task", () => {
    expect(
      shouldRecord({
        kind: "upserted",
        task: makeTask({ status: "failed" }),
        previous: makeTask({ status: "failed" }),
      }),
    ).toBeNull();
  });
});

describe("task-outcome-recorder summarizeOutcome", () => {
  it("uses label when present", () => {
    expect(summarizeOutcome(makeTask({ status: "succeeded", label: "Build prod bundle" }))).toBe(
      "Task succeeded: Build prod bundle",
    );
  });

  it("falls back to first line of task body", () => {
    expect(
      summarizeOutcome(
        makeTask({ status: "failed", task: "send slack message\n  to: #ops", error: "401" }),
      ),
    ).toBe("Task failed: send slack message — 401");
  });

  it("truncates oversized labels", () => {
    const long = "x".repeat(500);
    const out = summarizeOutcome(makeTask({ status: "succeeded", label: long }));
    expect(out.length).toBeLessThan(300);
    expect(out.startsWith("Task succeeded: ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("task-outcome-recorder buildOutcomeRecord", () => {
  it("emits a JSON-serializable record with timestamp and durationMs", () => {
    const task = makeTask({
      taskId: "abc",
      status: "succeeded",
      runtime: "cli",
      agentId: "main",
      taskKind: "build",
      label: "Build prod bundle",
      startedAt: 1_000,
      endedAt: 4_500,
    });
    const record = buildOutcomeRecord(task, 5_000);
    expect(record).toMatchObject({
      type: "task.outcome",
      taskId: "abc",
      status: "succeeded",
      runtime: "cli",
      agentId: "main",
      taskKind: "build",
      label: "Build prod bundle",
      durationMs: 3_500,
    });
    expect(typeof record.timestamp).toBe("string");
    expect(record.summary).toContain("Build prod bundle");
  });

  it("omits agentId/taskKind/label when missing", () => {
    const task = makeTask({ status: "lost" });
    const record = buildOutcomeRecord(task, 5_000);
    expect(record.agentId).toBeUndefined();
    expect(record.taskKind).toBeUndefined();
    expect(record.label).toBeUndefined();
    expect(record.durationMs).toBeUndefined();
  });
});
