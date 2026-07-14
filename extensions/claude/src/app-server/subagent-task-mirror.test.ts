import { describe, expect, it, vi } from "vitest";
import {
  claudeNativeSubagentRunId,
  ClaudeNativeSubagentTaskMirror,
  type ClaudeSubagentTaskLifecycleRuntime,
} from "./subagent-task-mirror.js";

function makeRuntime(overrides: Partial<ClaudeSubagentTaskLifecycleRuntime> = {}) {
  const created: unknown[] = [];
  const finalized: unknown[] = [];
  const runtime: ClaudeSubagentTaskLifecycleRuntime = {
    tryCreateRunningTaskRun: vi.fn((params) => {
      created.push(params);
      return { id: "task-1" } as never;
    }),
    finalizeTaskRunByRunId: vi.fn((params) => {
      finalized.push(params);
      return [] as never;
    }),
    ...overrides,
  };
  return { runtime, created, finalized };
}

describe("ClaudeNativeSubagentTaskMirror", () => {
  it("creates a task run on the first activity pulse and stays idempotent on later pulses", () => {
    const { runtime, created } = makeRuntime();
    const mirror = new ClaudeNativeSubagentTaskMirror(
      { threadId: "t1", turnId: "u1", agentId: "main" },
      runtime,
    );

    mirror.noteActivity();
    mirror.noteActivity();
    mirror.noteActivity();

    expect(created).toHaveLength(1);
    expect(mirror.isActive()).toBe(true);
    expect(created[0]).toMatchObject({
      runId: claudeNativeSubagentRunId("t1", "u1"),
      agentId: "main",
      label: "Claude subagent",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
    });
  });

  it("finalize() is a no-op when no activity was ever noted", () => {
    const { runtime, finalized } = makeRuntime();
    const mirror = new ClaudeNativeSubagentTaskMirror({ threadId: "t1", turnId: "u1" }, runtime);
    mirror.finalize("succeeded");
    expect(finalized).toHaveLength(0);
  });

  it("finalize() closes an active task exactly once with the given status", () => {
    const { runtime, finalized } = makeRuntime();
    const mirror = new ClaudeNativeSubagentTaskMirror({ threadId: "t1", turnId: "u1" }, runtime);

    mirror.noteActivity();
    mirror.finalize("succeeded");
    expect(mirror.isActive()).toBe(false);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      runId: claudeNativeSubagentRunId("t1", "u1"),
      status: "succeeded",
    });

    // Calling finalize again (e.g. from both a real-progress note and the
    // eventual turn-settle cleanup) must not double-finalize.
    mirror.finalize("cancelled");
    expect(finalized).toHaveLength(1);
  });

  it("a new activity pulse after finalize starts a fresh task run", () => {
    const { runtime, created, finalized } = makeRuntime();
    const mirror = new ClaudeNativeSubagentTaskMirror({ threadId: "t1", turnId: "u1" }, runtime);

    mirror.noteActivity();
    mirror.finalize("succeeded");
    mirror.noteActivity();

    expect(created).toHaveLength(2);
    expect(finalized).toHaveLength(1);
    expect(mirror.isActive()).toBe(true);
  });

  it("stops trying to create a task run after task persistence fails once", () => {
    const { runtime, created } = makeRuntime({
      tryCreateRunningTaskRun: vi.fn(() => null as never),
    });
    const mirror = new ClaudeNativeSubagentTaskMirror({ threadId: "t1", turnId: "u1" }, runtime);

    mirror.noteActivity();
    mirror.noteActivity();

    expect(created).toHaveLength(0);
    expect(mirror.isActive()).toBe(false);
    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledTimes(1);
  });

  it("scopes the run id to both threadId and turnId, so concurrent turns don't collide", () => {
    expect(claudeNativeSubagentRunId("thread-a", "turn-1")).toBe("claude-subagent:thread-a:turn-1");
    expect(claudeNativeSubagentRunId("thread-a", "turn-2")).not.toBe(
      claudeNativeSubagentRunId("thread-a", "turn-1"),
    );
  });
});
