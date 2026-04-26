import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  TASK_EVENT_SIZE_CAP_BYTES,
  TaskTrajectoryEventTooLargeError,
  __resetRecorderRegistry,
  deriveSidecarPath,
  getRecorder,
} from "../src/trajectory.js";

let tmpRoot: string;
let sessionsDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orchestrator-trajectory-"));
  sessionsDir = join(tmpRoot, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  sessionFile = join(sessionsDir, "abc123.jsonl");
  __resetRecorderRegistry();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetRecorderRegistry();
});

describe("deriveSidecarPath", () => {
  test("converts <sid>.jsonl to <sid>.tasks.jsonl", () => {
    expect(deriveSidecarPath("/x/sessions/abc.jsonl")).toBe("/x/sessions/abc.tasks.jsonl");
  });

  test("converts <sid>.trajectory.jsonl to <sid>.tasks.jsonl", () => {
    expect(deriveSidecarPath("/x/sessions/abc.trajectory.jsonl")).toBe(
      "/x/sessions/abc.tasks.jsonl",
    );
  });

  test("appends .tasks.jsonl when sessionFile has no recognized suffix", () => {
    expect(deriveSidecarPath("/x/sessions/raw")).toBe("/x/sessions/raw.tasks.jsonl");
  });
});

describe("getRecorder", () => {
  test("emits an event with the canonical openclaw-trajectory envelope", () => {
    const recorder = getRecorder({
      sessionId: "abc123",
      sessionFile,
    });
    const event = recorder.record("task.queued", {
      kind: "queued",
      taskId: "T1",
      goal: "test",
      submittedBy: "tester",
    });
    expect(event.traceSchema).toBe("openclaw-trajectory");
    expect(event.schemaVersion).toBe(1);
    expect(event.source).toBe("runtime");
    expect(event.type).toBe("task.queued");
    expect(event.sessionId).toBe("abc123");
    expect(event.traceId).toBe("abc123");
    expect(event.seq).toBe(1);
    expect(event.data.kind).toBe("queued");
  });

  test("seq increments per emit", () => {
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    recorder.record("task.queued", {
      kind: "queued",
      taskId: "T1",
      goal: "g",
      submittedBy: "u",
    });
    recorder.record("task.assigned", {
      kind: "assigned",
      taskId: "T1",
      agentId: "coder",
      ruleId: "code-tasks",
      capabilities: [],
    });
    recorder.record("task.done", {
      kind: "done",
      taskId: "T1",
      agentId: "coder",
      durationMs: 10,
    });
    expect(recorder.currentSeq).toBe(3);
  });

  test("two recorders for the same sidecar share their seq counter", () => {
    const a = getRecorder({ sessionId: "abc123", sessionFile });
    a.record("task.queued", {
      kind: "queued",
      taskId: "T1",
      goal: "g",
      submittedBy: "u",
    });
    const b = getRecorder({ sessionId: "abc123", sessionFile });
    const event = b.record("task.assigned", {
      kind: "assigned",
      taskId: "T1",
      agentId: "coder",
      ruleId: "code-tasks",
      capabilities: [],
    });
    expect(event.seq).toBe(2);
  });

  test("appends one JSONL line per record() call", () => {
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    recorder.record("task.queued", {
      kind: "queued",
      taskId: "T1",
      goal: "a",
      submittedBy: "u",
    });
    recorder.record("task.queued", {
      kind: "queued",
      taskId: "T2",
      goal: "b",
      submittedBy: "u",
    });
    const text = readFileSync(recorder.sidecarPath, "utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).data.taskId).toBe("T1");
    expect(JSON.parse(lines[1]!).data.taskId).toBe("T2");
  });

  test("sidecar path is derived from sessionFile (not a separate dir)", () => {
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    expect(recorder.sidecarPath).toBe(resolve(sessionsDir, "abc123.tasks.jsonl"));
  });

  test("creates the sidecar directory if it does not yet exist", () => {
    const deepFile = join(tmpRoot, "deep", "nested", "abc123.jsonl");
    const recorder = getRecorder({ sessionId: "abc123", sessionFile: deepFile });
    recorder.record("task.queued", {
      kind: "queued",
      taskId: "T1",
      goal: "g",
      submittedBy: "u",
    });
    expect(readFileSync(recorder.sidecarPath, "utf8")).toContain("T1");
  });

  test("throws TaskTrajectoryEventTooLargeError when an event exceeds 64KB", () => {
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    const huge = "x".repeat(TASK_EVENT_SIZE_CAP_BYTES);
    expect(() =>
      recorder.record("task.queued", {
        kind: "queued",
        taskId: "T1",
        goal: huge,
        submittedBy: "u",
      }),
    ).toThrow(TaskTrajectoryEventTooLargeError);
  });

  test("carries sessionKey and traceId overrides into the envelope", () => {
    const recorder = getRecorder({
      sessionId: "abc123",
      sessionFile,
      sessionKey: "key-1",
      traceId: "trace-7",
    });
    const event = recorder.record("task.queued", {
      kind: "queued",
      taskId: "T1",
      goal: "g",
      submittedBy: "u",
    });
    expect(event.sessionKey).toBe("key-1");
    expect(event.traceId).toBe("trace-7");
  });

  test("does not emit sessionKey when none is supplied", () => {
    const recorder = getRecorder({ sessionId: "abc123", sessionFile });
    const event = recorder.record("task.queued", {
      kind: "queued",
      taskId: "T1",
      goal: "g",
      submittedBy: "u",
    });
    expect(Object.prototype.hasOwnProperty.call(event, "sessionKey")).toBe(false);
  });
});
