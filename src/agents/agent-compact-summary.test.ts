import { describe, expect, it } from "vitest";
import {
  buildCompactContinuationFromTask,
  buildCompactSummaryFromTask,
  formatCompactSummary,
  getCompactContinuationMessage,
  renderMidTaskProgressLine,
} from "./agent-compact-summary.js";
import {
  advanceTaskStep,
  addTaskSources,
  completeTask,
  createTaskState,
  startTask,
  blockTask,
} from "./agent-task-state.js";

function makeTask() {
  return createTaskState({
    task_id: "task_001",
    title: "对比方案",
    goal: "对比三个候选技术方案的优劣",
    pending_steps: ["读取方案文档", "提取关键参数", "生成对比表"],
  });
}

describe("buildCompactSummaryFromTask", () => {
  it("maps task fields to CompactSummaryFields", () => {
    const task = addTaskSources(advanceTaskStep(startTask(makeTask()), "读取方案文档"), [
      "https://doc1.com",
    ]);
    const fields = buildCompactSummaryFromTask(task, {
      tools_used: [{ tool: "lark-doc", summary: "读取了方案文档 3 份" }],
      key_findings: ["方案 A 延迟最低", "方案 C 成本最高"],
      next_step: "生成对比表",
    });

    expect(fields.user_goal).toBe("对比三个候选技术方案的优劣");
    expect(fields.completed_steps).toContain("读取方案文档");
    expect(fields.tools_used[0]?.tool).toBe("lark-doc");
    expect(fields.key_findings).toContain("方案 A 延迟最低");
    expect(fields.sources).toContain("https://doc1.com");
    expect(fields.next_step).toBe("生成对比表");
  });

  it("uses first pending step as next_step when not provided", () => {
    const fields = buildCompactSummaryFromTask(startTask(makeTask()));
    expect(fields.next_step).toBe("读取方案文档");
  });

  it("sets next_step fallback when no pending steps", () => {
    const task = completeTask(startTask(makeTask()));
    const fields = buildCompactSummaryFromTask(task);
    expect(fields.next_step).toBe("No pending steps.");
  });
});

describe("formatCompactSummary", () => {
  it("wraps output in <summary> tags", () => {
    const fields = buildCompactSummaryFromTask(startTask(makeTask()));
    const out = formatCompactSummary(fields);
    expect(out).toMatch(/^<summary>/);
    expect(out).toMatch(/<\/summary>$/);
  });

  it("includes 用户目标 and 当前状态", () => {
    const task = startTask(makeTask());
    const out = formatCompactSummary(buildCompactSummaryFromTask(task));
    expect(out).toContain("用户目标:");
    expect(out).toContain("当前状态:");
  });

  it("includes tools_used entries", () => {
    const fields = buildCompactSummaryFromTask(startTask(makeTask()), {
      tools_used: [{ tool: "lark-base", summary: "读取了 5 行" }],
    });
    const out = formatCompactSummary(fields);
    expect(out).toContain("lark-base");
    expect(out).toContain("读取了 5 行");
  });

  it("includes blockers from task", () => {
    const task = blockTask(startTask(makeTask()), "飞书 API 限流");
    const out = formatCompactSummary(buildCompactSummaryFromTask(task));
    expect(out).toContain("飞书 API 限流");
  });

  it("omits empty sections", () => {
    const task = startTask(makeTask());
    const out = formatCompactSummary(buildCompactSummaryFromTask(task));
    // No tools_used or key_findings in default task
    expect(out).not.toContain("已调用工具:");
    expect(out).not.toContain("关键发现:");
  });
});

describe("getCompactContinuationMessage", () => {
  it("includes the summary text", () => {
    const msg = getCompactContinuationMessage({
      summary: "<summary>任务目标: 测试</summary>",
      hasRecentMessages: false,
    });
    expect(msg).toContain("任务目标: 测试");
  });

  it("appends recent messages note when hasRecentMessages is true", () => {
    const msg = getCompactContinuationMessage({
      summary: "summary text",
      hasRecentMessages: true,
    });
    expect(msg).toContain("最近的消息已完整保留");
  });

  it("appends no-questions directive by default", () => {
    const msg = getCompactContinuationMessage({
      summary: "s",
      hasRecentMessages: false,
    });
    expect(msg).toContain("不要询问用户");
  });

  it("omits no-questions directive when suppressFollowUpQuestions is false", () => {
    const msg = getCompactContinuationMessage({
      summary: "s",
      hasRecentMessages: false,
      suppressFollowUpQuestions: false,
    });
    expect(msg).not.toContain("不要询问用户");
  });
});

describe("buildCompactContinuationFromTask", () => {
  it("produces a non-empty string with task goal", () => {
    const task = advanceTaskStep(startTask(makeTask()), "读取方案文档");
    const out = buildCompactContinuationFromTask(task);
    expect(out).toContain("对比三个候选技术方案的优劣");
    expect(out.length).toBeGreaterThan(50);
  });
});

describe("renderMidTaskProgressLine", () => {
  it("shows 0% when no steps completed", () => {
    const task = startTask(makeTask());
    const line = renderMidTaskProgressLine(task);
    expect(line).toContain("0%");
    expect(line).toContain("0/3");
  });

  it("shows partial progress", () => {
    const task = advanceTaskStep(startTask(makeTask()));
    const line = renderMidTaskProgressLine(task);
    expect(line).toContain("33%");
    expect(line).toContain("1/3");
  });

  it("shows 100% when all steps done", () => {
    const task = completeTask(startTask(makeTask()));
    // completeTask clears pending_steps but completed_steps was 0 before; simulate advancing
    let t = startTask(makeTask());
    t = advanceTaskStep(advanceTaskStep(advanceTaskStep(t)));
    t = completeTask(t);
    const line = renderMidTaskProgressLine(t);
    expect(line).toContain("100%");
  });

  it("handles tasks with no steps (division by zero guard)", () => {
    const task = createTaskState({ task_id: "t", title: "no steps", goal: "g" });
    const line = renderMidTaskProgressLine(task);
    expect(line).toContain("0%");
  });
});
