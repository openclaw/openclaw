import { describe, expect, it } from "vitest";
import {
  addTaskSources,
  advanceTaskStep,
  blockTask,
  completeTask,
  createTaskState,
  failTask,
  isTaskTerminal,
  recordTaskOutputs,
  renderTaskSummary,
  startTask,
  unblockTask,
} from "./agent-task-state.js";

function makeTask() {
  return createTaskState({
    task_id: "task_001",
    title: "整理项目状态",
    goal: "汇总项目当前风险和下一步动作",
    pending_steps: ["读取项目表", "读取会议纪要", "汇总风险", "生成下一步动作"],
  });
}

describe("createTaskState", () => {
  it("initializes with pending status", () => {
    const task = makeTask();
    expect(task.status).toBe("pending");
    expect(task.completed_steps).toEqual([]);
    expect(task.pending_steps).toHaveLength(4);
  });

  it("defaults owner to main_agent", () => {
    const task = makeTask();
    expect(task.owner).toBe("main_agent");
  });

  it("records created_at and updated_at as ISO strings", () => {
    const task = makeTask();
    expect(() => new Date(task.created_at)).not.toThrow();
    expect(() => new Date(task.updated_at)).not.toThrow();
  });
});

describe("startTask", () => {
  it("transitions to running", () => {
    const task = startTask(makeTask());
    expect(task.status).toBe("running");
  });
});

describe("advanceTaskStep", () => {
  it("moves first pending step to completed", () => {
    const task = advanceTaskStep(startTask(makeTask()));
    expect(task.completed_steps).toEqual(["读取项目表"]);
    expect(task.pending_steps[0]).toBe("读取会议纪要");
  });

  it("advances a named step regardless of position", () => {
    const task = advanceTaskStep(startTask(makeTask()), "汇总风险");
    expect(task.completed_steps).toContain("汇总风险");
    expect(task.pending_steps).not.toContain("汇总风险");
  });

  it("is a no-op when there are no pending steps", () => {
    const task = createTaskState({ task_id: "t", title: "t", goal: "g" });
    const advanced = advanceTaskStep(task);
    expect(advanced).toEqual(task);
  });
});

describe("blockTask / unblockTask", () => {
  it("sets status to blocked and records blocker", () => {
    const task = blockTask(startTask(makeTask()), "等待外部数据");
    expect(task.status).toBe("blocked");
    expect(task.blockers).toContain("等待外部数据");
  });

  it("unblocks and returns to running when all blockers cleared", () => {
    const blocked = blockTask(startTask(makeTask()), "等待外部数据");
    const unblocked = unblockTask(blocked, "等待外部数据");
    expect(unblocked.status).toBe("running");
    expect(unblocked.blockers).toEqual([]);
  });

  it("remains blocked when other blockers remain", () => {
    let task = startTask(makeTask());
    task = blockTask(task, "blocker_a");
    task = blockTask(task, "blocker_b");
    const partial = unblockTask(task, "blocker_a");
    expect(partial.status).toBe("blocked");
    expect(partial.blockers).toEqual(["blocker_b"]);
  });

  it("clears all blockers when no specific blocker given", () => {
    let task = startTask(makeTask());
    task = blockTask(task, "blocker_a");
    task = blockTask(task, "blocker_b");
    const cleared = unblockTask(task);
    expect(cleared.status).toBe("running");
    expect(cleared.blockers).toEqual([]);
  });
});

describe("recordTaskOutputs", () => {
  it("merges outputs shallowly", () => {
    let task = startTask(makeTask());
    task = recordTaskOutputs(task, { summary: "draft 1" });
    task = recordTaskOutputs(task, { risks: ["risk A"] });
    expect(task.outputs).toEqual({ summary: "draft 1", risks: ["risk A"] });
  });
});

describe("addTaskSources", () => {
  it("deduplicates sources", () => {
    let task = addTaskSources(makeTask(), ["https://a.com", "https://b.com"]);
    task = addTaskSources(task, ["https://b.com", "https://c.com"]);
    expect(task.sources).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  });
});

describe("completeTask / failTask", () => {
  it("completeTask sets status and clears pending steps", () => {
    const task = completeTask(startTask(makeTask()));
    expect(task.status).toBe("completed");
    expect(task.pending_steps).toEqual([]);
  });

  it("failTask sets status and records reason", () => {
    const task = failTask(startTask(makeTask()), "无法读取外部数据源");
    expect(task.status).toBe("failed");
    expect(task.blockers).toContain("无法读取外部数据源");
  });
});

describe("isTaskTerminal", () => {
  it("returns true for completed", () => {
    expect(isTaskTerminal(completeTask(makeTask()))).toBe(true);
  });

  it("returns true for failed", () => {
    expect(isTaskTerminal(failTask(makeTask()))).toBe(true);
  });

  it.each(["pending", "running", "waiting_for_user", "blocked"] as const)(
    "returns false for %s",
    (status) => {
      const task = { ...makeTask(), status };
      expect(isTaskTerminal(task)).toBe(false);
    },
  );
});

describe("renderTaskSummary", () => {
  it("includes goal, status, and steps", () => {
    let task = startTask(makeTask());
    task = advanceTaskStep(task);
    task = advanceTaskStep(task);
    const summary = renderTaskSummary(task);
    expect(summary).toContain("running");
    expect(summary).toContain("整理项目状态");
    expect(summary).toContain("读取项目表");
    expect(summary).toContain("汇总风险");
  });

  it("includes blockers when present", () => {
    const task = blockTask(startTask(makeTask()), "API 不可用");
    const summary = renderTaskSummary(task);
    expect(summary).toContain("API 不可用");
  });

  it("includes sources when present", () => {
    const task = addTaskSources(makeTask(), ["https://example.com"]);
    const summary = renderTaskSummary(task);
    expect(summary).toContain("https://example.com");
  });
});
