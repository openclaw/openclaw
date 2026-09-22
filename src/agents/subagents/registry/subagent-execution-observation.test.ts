import { afterEach, describe, expect, it } from "vitest";
import { getSubagentExecutionObservation } from "./subagent-execution-observation.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function run(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: runId,
    createdAt: Date.now(),
    cleanup: "keep",
    generation: 1,
    execution: { status: "running", startedAt: Date.now() },
    ...overrides,
  };
}

afterEach(() => subagentRuns.clear());

describe("subagent execution observation", () => {
  it("follows the task across successor runs without borrowing another task or generation", () => {
    const original = run("original");
    subagentRuns.set(original.runId, original);
    const target = { taskRunId: original.runId, childSessionKey: original.childSessionKey };
    expect(getSubagentExecutionObservation(target)).toEqual({
      state: "running",
      executionRunId: original.runId,
    });

    const successor = run("successor", {
      taskRunId: original.runId,
      childSessionKey: original.childSessionKey,
      generation: 2,
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: Date.now() },
    });
    subagentRuns.delete(original.runId);
    subagentRuns.set(successor.runId, successor);
    expect(getSubagentExecutionObservation(target)).toEqual({
      state: "waiting",
      wait: { kind: "external" },
      executionRunId: successor.runId,
    });
    expect(getSubagentExecutionObservation({ ...target, generation: 1 })).toBeUndefined();
    expect(getSubagentExecutionObservation({ ...target, taskRunId: "other-task" })).toBeUndefined();
    const otherTask = run("other-task", {
      childSessionKey: original.childSessionKey,
      generation: 3,
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: Date.now() },
    });
    subagentRuns.set(otherTask.runId, otherTask);
    const privateChild = run("replacement-private-child", {
      requesterSessionKey: otherTask.childSessionKey,
      expectsCompletionMessage: true,
    });
    subagentRuns.set(privateChild.runId, privateChild);
    expect(getSubagentExecutionObservation(target)).toBeUndefined();
    expect(getSubagentExecutionObservation({ ...target, generation: 2 })).toBeUndefined();
    expect(
      getSubagentExecutionObservation({ ...target, taskRunId: otherTask.runId }),
    ).toMatchObject({
      executionRunId: otherTask.runId,
      wait: { kind: "children", pendingCount: 1 },
    });
    subagentRuns.clear();
    expect(getSubagentExecutionObservation(target)).toBeUndefined();
  });

  it("observes only latest announced children and clears dependencies after settlement or deletion", () => {
    const parent = run("parent", {
      pauseReason: "sessions_yield",
      execution: { status: "terminal", endedAt: Date.now() },
    });
    subagentRuns.set(parent.runId, parent);
    const child = run("child", {
      requesterSessionKey: parent.childSessionKey,
      expectsCompletionMessage: true,
    });
    const collector = run("collector", {
      requesterSessionKey: parent.childSessionKey,
      collect: true,
    });
    subagentRuns.set(child.runId, child);
    subagentRuns.set(collector.runId, collector);
    const target = { taskRunId: parent.runId, childSessionKey: parent.childSessionKey };
    expect(getSubagentExecutionObservation(target)?.wait).toEqual({
      kind: "children",
      pendingCount: 1,
      dependencies: [{ runId: child.runId, sessionKey: child.childSessionKey }],
    });
    const replacement = run("replacement", {
      childSessionKey: child.childSessionKey,
      requesterSessionKey: parent.childSessionKey,
      generation: 2,
      expectsCompletionMessage: true,
      execution: { status: "terminal", endedAt: Date.now() },
      cleanupCompletedAt: Date.now(),
    });
    subagentRuns.set(replacement.runId, replacement);
    expect(getSubagentExecutionObservation(target)?.wait).toEqual({ kind: "external" });
    replacement.pauseReason = "sessions_yield";
    replacement.endedReason = "subagent-killed";
    replacement.execution.outcome = { status: "error", error: "killed" };
    expect(getSubagentExecutionObservation(target)?.wait).toEqual({ kind: "external" });
    replacement.cleanupCompletedAt = undefined;
    expect(getSubagentExecutionObservation(target)?.wait).toMatchObject({
      kind: "children",
      pendingCount: 1,
    });
    subagentRuns.delete(child.runId);
    subagentRuns.delete(replacement.runId);
    expect(getSubagentExecutionObservation(target)?.wait).toEqual({ kind: "external" });
  });
});
