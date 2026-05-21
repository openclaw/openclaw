import { describe, expect, it } from "vitest";
import {
  buildTaskContextForChildPrompt,
  completeTaskAfterSubagent,
  mergeSubagentResultIntoTask,
  startTaskForSubagentSpawn,
  type SubagentResultForTaskMerge,
} from "./agent-subagent-task-bridge.js";
import {
  addTaskSources,
  advanceTaskStep,
  blockTask,
  createTaskState,
  isTaskTerminal,
  type AgentTaskState,
} from "./agent-task-state.js";

function makeTask(overrides?: Partial<Parameters<typeof createTaskState>[0]>): AgentTaskState {
  return createTaskState({
    task_id: "spawn-task-001",
    title: "子智能体协作任务",
    goal: "通过子智能体搜集数据并汇总",
    pending_steps: ["派发子智能体", "等待子智能体完成", "汇总结果"],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// startTaskForSubagentSpawn
// ---------------------------------------------------------------------------

describe("startTaskForSubagentSpawn", () => {
  it("transitions task from pending to running", () => {
    const task = makeTask();
    const started = startTaskForSubagentSpawn(task);
    expect(started.status).toBe("running");
  });

  it("preserves task_id, title, goal, and pending steps", () => {
    const task = makeTask();
    const started = startTaskForSubagentSpawn(task);
    expect(started.task_id).toBe("spawn-task-001");
    expect(started.title).toBe("子智能体协作任务");
    expect(started.goal).toBe("通过子智能体搜集数据并汇总");
    expect(started.pending_steps).toEqual(["派发子智能体", "等待子智能体完成", "汇总结果"]);
  });

  it("does not mutate the original task", () => {
    const task = makeTask();
    startTaskForSubagentSpawn(task);
    expect(task.status).toBe("pending");
  });

  it("updates updated_at timestamp", () => {
    const task = makeTask();
    const started = startTaskForSubagentSpawn(task);
    expect(new Date(started.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(task.updated_at).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// buildTaskContextForChildPrompt
// ---------------------------------------------------------------------------

describe("buildTaskContextForChildPrompt", () => {
  it("includes a Parent Task Context header", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const prompt = buildTaskContextForChildPrompt(task);
    expect(prompt).toContain("## Parent Task Context");
  });

  it("includes the task title and status", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const prompt = buildTaskContextForChildPrompt(task);
    expect(prompt).toContain("子智能体协作任务");
    expect(prompt).toContain("running");
  });

  it("includes pending steps", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const prompt = buildTaskContextForChildPrompt(task);
    expect(prompt).toContain("派发子智能体");
  });

  it("includes completed steps when present", () => {
    let task = startTaskForSubagentSpawn(makeTask());
    task = advanceTaskStep(task); // completes "派发子智能体"
    const prompt = buildTaskContextForChildPrompt(task);
    expect(prompt).toContain("派发子智能体");
  });

  it("includes sources when present", () => {
    let task = startTaskForSubagentSpawn(makeTask());
    task = addTaskSources(task, ["https://example.com/data"]);
    const prompt = buildTaskContextForChildPrompt(task);
    expect(prompt).toContain("https://example.com/data");
  });

  it("includes blockers when task is blocked", () => {
    const task = blockTask(startTaskForSubagentSpawn(makeTask()), "依赖服务不可用");
    const prompt = buildTaskContextForChildPrompt(task);
    expect(prompt).toContain("依赖服务不可用");
  });

  it("includes the task goal", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const prompt = buildTaskContextForChildPrompt(task);
    expect(prompt).toContain("通过子智能体搜集数据并汇总");
  });

  it("returns a non-empty string for a minimal task", () => {
    const task = startTaskForSubagentSpawn(
      createTaskState({ task_id: "t", title: "T", goal: "G" }),
    );
    const prompt = buildTaskContextForChildPrompt(task);
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// mergeSubagentResultIntoTask — accepted path
// ---------------------------------------------------------------------------

describe("mergeSubagentResultIntoTask — accepted", () => {
  it("advances the first pending step on accepted result", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = {
      status: "accepted",
      runId: "run-abc",
      childSessionKey: "agent:main:subagent:uuid-1",
    };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.completed_steps).toContain("派发子智能体");
    expect(merged.pending_steps).not.toContain("派发子智能体");
  });

  it("records runId in outputs when provided", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = { status: "accepted", runId: "run-xyz" };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.outputs.subagentRunId).toBe("run-xyz");
  });

  it("records childSessionKey in outputs when provided", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = {
      status: "accepted",
      childSessionKey: "agent:main:subagent:uuid-2",
    };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.outputs.subagentSessionKey).toBe("agent:main:subagent:uuid-2");
  });

  it("records both runId and childSessionKey when both provided", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = {
      status: "accepted",
      runId: "run-1",
      childSessionKey: "agent:main:subagent:uuid-3",
    };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.outputs.subagentRunId).toBe("run-1");
    expect(merged.outputs.subagentSessionKey).toBe("agent:main:subagent:uuid-3");
  });

  it("does not add spurious output keys when runId and childSessionKey are absent", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = { status: "accepted" };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(Object.keys(merged.outputs)).toHaveLength(0);
  });

  it("does not mark terminal on accepted — task is still running", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = { status: "accepted", runId: "run-1" };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(isTaskTerminal(merged)).toBe(false);
    expect(merged.status).toBe("running");
  });

  it("does not mutate the input task", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const originalPending = [...task.pending_steps];
    mergeSubagentResultIntoTask(task, { status: "accepted", runId: "run-1" });
    expect(task.pending_steps).toEqual(originalPending);
  });
});

// ---------------------------------------------------------------------------
// mergeSubagentResultIntoTask — error / forbidden paths
// ---------------------------------------------------------------------------

describe("mergeSubagentResultIntoTask — error", () => {
  it("fails the task on error status", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = {
      status: "error",
      error: "gateway timeout",
    };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.status).toBe("failed");
    expect(isTaskTerminal(merged)).toBe(true);
  });

  it("records the error message as a blocker", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = {
      status: "error",
      error: "spawn-failed: model unavailable",
    };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.blockers).toContain("spawn-failed: model unavailable");
  });

  it("fails the task on forbidden status", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = {
      status: "forbidden",
      error: "max spawn depth exceeded",
    };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.status).toBe("failed");
    expect(merged.blockers).toContain("max spawn depth exceeded");
  });

  it("uses a generic reason when error is absent", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = { status: "forbidden" };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.blockers.length).toBeGreaterThan(0);
    expect(merged.blockers[0]).toContain("forbidden");
  });

  it("uses a generic reason when error is empty string", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const result: SubagentResultForTaskMerge = { status: "error", error: "" };
    const merged = mergeSubagentResultIntoTask(task, result);
    expect(merged.blockers[0]).toContain("error");
  });

  it("does not mutate the input task on error", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const original = { ...task };
    mergeSubagentResultIntoTask(task, { status: "error", error: "fail" });
    expect(task.status).toBe(original.status);
    expect(task.blockers).toEqual(original.blockers);
  });
});

// ---------------------------------------------------------------------------
// completeTaskAfterSubagent
// ---------------------------------------------------------------------------

describe("completeTaskAfterSubagent", () => {
  it("marks the task completed", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const completed = completeTaskAfterSubagent(task);
    expect(completed.status).toBe("completed");
    expect(isTaskTerminal(completed)).toBe(true);
  });

  it("clears all remaining pending steps", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    const completed = completeTaskAfterSubagent(task);
    expect(completed.pending_steps).toEqual([]);
  });

  it("does not mutate the input task", () => {
    const task = startTaskForSubagentSpawn(makeTask());
    completeTaskAfterSubagent(task);
    expect(task.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: create → start → merge(accepted) → merge(next) → complete
// ---------------------------------------------------------------------------

describe("full spawn lifecycle", () => {
  it("correctly tracks state through a complete subagent lifecycle", () => {
    // Step 1: create task
    const initial = makeTask();
    expect(initial.status).toBe("pending");

    // Step 2: start at spawn
    const started = startTaskForSubagentSpawn(initial);
    expect(started.status).toBe("running");

    // Step 3: merge accepted result — first step (派发子智能体) advances
    const afterDispatch = mergeSubagentResultIntoTask(started, {
      status: "accepted",
      runId: "run-dispatch-1",
      childSessionKey: "agent:main:subagent:uuid-lifecycle",
    });
    expect(afterDispatch.completed_steps).toContain("派发子智能体");
    expect(afterDispatch.outputs.subagentRunId).toBe("run-dispatch-1");

    // Step 4: advance second step manually (等待子智能体完成)
    const afterWait = advanceTaskStep(afterDispatch, "等待子智能体完成");
    expect(afterWait.completed_steps).toContain("等待子智能体完成");

    // Step 5: complete
    const completed = completeTaskAfterSubagent(afterWait);
    expect(completed.status).toBe("completed");
    expect(completed.pending_steps).toEqual([]);
    expect(isTaskTerminal(completed)).toBe(true);
  });

  it("fails gracefully when spawn is forbidden at any step", () => {
    const started = startTaskForSubagentSpawn(makeTask());
    const failed = mergeSubagentResultIntoTask(started, {
      status: "forbidden",
      error: "sessions_spawn has reached max active children",
    });
    expect(failed.status).toBe("failed");
    expect(isTaskTerminal(failed)).toBe(true);
    expect(failed.blockers).toContain("sessions_spawn has reached max active children");
  });
});
