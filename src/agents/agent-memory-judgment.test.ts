import { describe, expect, it } from "vitest";
import { buildMemoryEntry, judgeMemoryWrite } from "./agent-memory-judgment.js";
import {
  addTaskSources,
  completeTask,
  createTaskState,
  failTask,
  startTask,
} from "./agent-task-state.js";

function makeCompletedTask() {
  return completeTask(
    addTaskSources(
      startTask(
        createTaskState({
          task_id: "t1",
          title: "制定会议流程",
          goal: "为每周例会制定标准流程",
        }),
      ),
      ["https://lark.com/doc/xyz"],
    ),
  );
}

describe("judgeMemoryWrite", () => {
  it("never writes when sensitive data is involved", () => {
    const result = judgeMemoryWrite({
      task: makeCompletedTask(),
      userRequestedMemory: true,
      involvesSensitiveData: true,
    });
    expect(result.write).toBe(false);
    expect(result.reason).toMatch(/sensitive/i);
  });

  it("never writes personal memory in group context", () => {
    const result = judgeMemoryWrite({
      task: makeCompletedTask(),
      userRequestedMemory: true,
      isGroupContext: true,
    });
    expect(result.write).toBe(false);
    expect(result.reason).toMatch(/group/i);
  });

  it("writes long_term when user explicitly requests", () => {
    const result = judgeMemoryWrite({
      task: makeCompletedTask(),
      userRequestedMemory: true,
    });
    expect(result.write).toBe(true);
    expect(result.type).toBe("long_term");
    expect(result.suggested_entry).toBeDefined();
  });

  it("writes long_term for reusable workflow", () => {
    const result = judgeMemoryWrite({
      task: makeCompletedTask(),
      hasReusableWorkflow: true,
    });
    expect(result.write).toBe(true);
    expect(result.type).toBe("long_term");
  });

  it("writes long_term for user preference", () => {
    const result = judgeMemoryWrite({
      task: makeCompletedTask(),
      hasUserPreference: true,
    });
    expect(result.write).toBe(true);
    expect(result.type).toBe("long_term");
  });

  it("writes project for pending follow-up", () => {
    const result = judgeMemoryWrite({
      task: makeCompletedTask(),
      hasPendingFollowUp: true,
    });
    expect(result.write).toBe(true);
    expect(result.type).toBe("project");
  });

  it("writes project for project state change", () => {
    const result = judgeMemoryWrite({
      task: makeCompletedTask(),
      hasProjectStateChange: true,
    });
    expect(result.write).toBe(true);
    expect(result.type).toBe("project");
  });

  it("skips writing with no positive signals", () => {
    const result = judgeMemoryWrite({ task: makeCompletedTask() });
    expect(result.write).toBe(false);
    expect(result.type).toBe("short_term");
  });

  it("sensitive data overrides even explicit user request", () => {
    const result = judgeMemoryWrite({
      task: makeCompletedTask(),
      userRequestedMemory: true,
      hasReusableWorkflow: true,
      involvesSensitiveData: true,
    });
    expect(result.write).toBe(false);
  });
});

describe("buildMemoryEntry", () => {
  it("includes the date, title, and goal", () => {
    const task = makeCompletedTask();
    const entry = buildMemoryEntry(task, "long_term");
    const today = new Date().toISOString().split("T")[0];
    expect(entry).toContain(`## ${today}`);
    expect(entry).toContain("制定会议流程");
    expect(entry).toContain("为每周例会制定标准流程");
  });

  it("includes sources", () => {
    const task = makeCompletedTask();
    const entry = buildMemoryEntry(task, "long_term");
    expect(entry).toContain("https://lark.com/doc/xyz");
  });

  it("marks long_term with comment", () => {
    const entry = buildMemoryEntry(makeCompletedTask(), "long_term");
    expect(entry).toContain("<!-- 长期记忆 -->");
  });

  it("marks project memory with comment", () => {
    const entry = buildMemoryEntry(makeCompletedTask(), "project");
    expect(entry).toContain("<!-- 项目记忆 -->");
  });

  it("includes pending steps in 待跟进 field", () => {
    const task = startTask(
      createTaskState({
        task_id: "t2",
        title: "项目状态",
        goal: "汇总",
        pending_steps: ["补充文档", "发通知"],
      }),
    );
    const entry = buildMemoryEntry(task, "project");
    expect(entry).toContain("补充文档");
    expect(entry).toContain("发通知");
  });

  it("says 无 in 待跟进 when no pending steps", () => {
    const task = completeTask(createTaskState({ task_id: "t3", title: "完成任务", goal: "g" }));
    const entry = buildMemoryEntry(task, "long_term");
    expect(entry).toContain("待跟进：无");
  });

  it("says 无 in 相关来源 when no sources", () => {
    const task = completeTask(createTaskState({ task_id: "t4", title: "无来源任务", goal: "g" }));
    const entry = buildMemoryEntry(task, "long_term");
    expect(entry).toContain("相关来源：无");
  });

  it("includes failed status in conclusion", () => {
    const task = failTask(
      startTask(createTaskState({ task_id: "t5", title: "失败任务", goal: "g" })),
      "无法访问 API",
    );
    const entry = buildMemoryEntry(task, "project");
    expect(entry).toContain("failed");
  });
});

describe("integration: judge then build entry", () => {
  it("produces a valid memory entry when write is true", () => {
    const task = makeCompletedTask();
    const judgment = judgeMemoryWrite({ task, userRequestedMemory: true });
    expect(judgment.write).toBe(true);
    expect(judgment.suggested_entry).toBeDefined();
    // Entry must include canonical section headers
    const entry = judgment.suggested_entry!;
    expect(entry).toContain("背景：");
    expect(entry).toContain("结论：");
    expect(entry).toContain("已完成");
    expect(entry).toContain("待跟进：");
    expect(entry).toContain("相关来源：");
  });
});
