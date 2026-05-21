/**
 * Phase 5 integration tests: AgentTaskState propagation through spawnSubagentDirect.
 *
 * Verifies:
 * - Backcompat: spawn without taskState returns no taskStateAtDispatch (no regression).
 * - When taskState is provided, result.taskStateAtDispatch is in "running" state.
 * - When spawn is accepted with taskState, taskStateAtDispatch reflects the started task.
 * - When spawn fails (gateway error), taskStateAtDispatch is absent (task never started).
 * - Task state merging with mergeSubagentResultIntoTask produces correct terminal state.
 */

import { describe, expect, it, vi } from "vitest";
import { mergeSubagentResultIntoTask } from "./agent-subagent-task-bridge.js";
import { createTaskState } from "./agent-task-state.js";
import {
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

function makeBaseTask() {
  return createTaskState({
    task_id: "phase5-test-001",
    title: "集成测试父任务",
    goal: "通过子智能体执行数据查询并返回结果",
    pending_steps: ["启动子智能体", "等待完成", "汇总"],
  });
}

// ---------------------------------------------------------------------------
// Backcompat: existing callers without taskState are unaffected
// ---------------------------------------------------------------------------

describe("backcompat — no taskState passed", () => {
  it("accepted result does not include taskStateAtDispatch", async () => {
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({ callGatewayMock });

    const result = await spawnSubagentDirect(
      { task: "run a quick data check" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("accepted");
    expect(result).not.toHaveProperty("taskStateAtDispatch");
  });

  it("error result does not include taskStateAtDispatch", async () => {
    const callGatewayMock = vi.fn().mockRejectedValue(new Error("gateway down"));
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({ callGatewayMock });

    const result = await spawnSubagentDirect(
      { task: "run a quick data check" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("error");
    expect(result).not.toHaveProperty("taskStateAtDispatch");
  });
});

// ---------------------------------------------------------------------------
// Phase 5: taskState propagation
// ---------------------------------------------------------------------------

describe("Phase 5 — taskState propagation", () => {
  it("accepted spawn returns taskStateAtDispatch in running state", async () => {
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({ callGatewayMock });

    const task = makeBaseTask();
    const result = await spawnSubagentDirect(
      { task: "fetch project data", taskState: task },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("accepted");
    expect(result.taskStateAtDispatch).toBeDefined();
    expect(result.taskStateAtDispatch?.status).toBe("running");
  });

  it("taskStateAtDispatch preserves task_id and goal", async () => {
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({ callGatewayMock });

    const task = makeBaseTask();
    const result = await spawnSubagentDirect(
      { task: "fetch project data", taskState: task },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.taskStateAtDispatch?.task_id).toBe("phase5-test-001");
    expect(result.taskStateAtDispatch?.goal).toBe("通过子智能体执行数据查询并返回结果");
    expect(result.taskStateAtDispatch?.title).toBe("集成测试父任务");
  });

  it("taskStateAtDispatch retains original pending steps", async () => {
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({ callGatewayMock });

    const task = makeBaseTask();
    const result = await spawnSubagentDirect(
      { task: "fetch project data", taskState: task },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.taskStateAtDispatch?.pending_steps).toEqual(["启动子智能体", "等待完成", "汇总"]);
  });

  it("does not mutate the caller-provided task", async () => {
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({ callGatewayMock });

    const task = makeBaseTask();
    await spawnSubagentDirect(
      { task: "fetch project data", taskState: task },
      { agentSessionKey: "agent:main:main" },
    );

    expect(task.status).toBe("pending"); // original is unchanged
  });

  it("taskStateAtDispatch is absent when spawn is forbidden (invalid agentId)", async () => {
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({ callGatewayMock });

    const task = makeBaseTask();
    const result = await spawnSubagentDirect(
      { task: "fetch data", agentId: "INVALID AGENT ID!!", taskState: task },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("error");
    // taskStateAtDispatch is not returned for pre-validation errors
    expect(result.taskStateAtDispatch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Caller workflow: merge result back into task state
// ---------------------------------------------------------------------------

describe("Phase 5 — caller merges spawn result into task state", () => {
  it("advancing step after accepted spawn produces correct task state", async () => {
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({ callGatewayMock });

    const task = makeBaseTask();
    const result = await spawnSubagentDirect(
      { task: "fetch project data", taskState: task },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("accepted");
    const dispatched = result.taskStateAtDispatch!;

    // Caller merges the result (accepted → advance step)
    const merged = mergeSubagentResultIntoTask(dispatched, {
      status: result.status,
      runId: result.runId,
      childSessionKey: result.childSessionKey,
    });

    expect(merged.completed_steps).toContain("启动子智能体");
    expect(merged.outputs.subagentRunId).toBe("run-1"); // from setupAcceptedSubagentGatewayMock
    expect(merged.status).toBe("running");
  });

  it("simulated error result fails the task correctly", () => {
    const task = createTaskState({
      task_id: "err-task",
      title: "Error test",
      goal: "test error merging",
      pending_steps: ["step-a"],
    });

    const merged = mergeSubagentResultIntoTask(
      { ...task, status: "running" },
      { status: "error", error: "gateway timeout" },
    );

    expect(merged.status).toBe("failed");
    expect(merged.blockers).toContain("gateway timeout");
  });
});
