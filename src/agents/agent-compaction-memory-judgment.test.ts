import { describe, expect, it } from "vitest";
import {
  buildPostCompactionMemoryJudgment,
  type PostCompactionMemorySignals,
} from "./agent-compaction-memory-judgment.js";
import type { AgentTaskState } from "./agent-task-state.js";
import { completeTask, createTaskState, failTask, startTask } from "./agent-task-state.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<AgentTaskState>): AgentTaskState {
  return {
    ...createTaskState({
      task_id: "cmp-001",
      title: "Summarize weekly report",
      goal: "Fetch and summarize the Q1 metrics report",
    }),
    ...overrides,
  };
}

function makeCompletedTask(): AgentTaskState {
  return completeTask(startTask(makeTask()));
}

// ---------------------------------------------------------------------------
// buildPostCompactionMemoryJudgment — no task state (backcompat)
// ---------------------------------------------------------------------------

describe("buildPostCompactionMemoryJudgment — no task state", () => {
  it("returns undefined when taskState is absent", () => {
    const result = buildPostCompactionMemoryJudgment({});
    expect(result).toBeUndefined();
  });

  it("returns undefined when taskState is explicitly undefined", () => {
    const result = buildPostCompactionMemoryJudgment({ taskState: undefined });
    expect(result).toBeUndefined();
  });

  it("returns undefined when taskState is absent even with signals", () => {
    const signals: PostCompactionMemorySignals = { userRequestedMemory: true };
    const result = buildPostCompactionMemoryJudgment({ signals });
    expect(result).toBeUndefined();
  });

  it("never throws when called with no args", () => {
    expect(() => buildPostCompactionMemoryJudgment({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildPostCompactionMemoryJudgment — no positive signals
// ---------------------------------------------------------------------------

describe("buildPostCompactionMemoryJudgment — no signals", () => {
  it("returns write:false with no signals", () => {
    const result = buildPostCompactionMemoryJudgment({ taskState: makeCompletedTask() });
    expect(result).toBeDefined();
    expect(result!.write).toBe(false);
    expect(result!.type).toBe("short_term");
  });

  it("returns write:false with empty signals object", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: {},
    });
    expect(result!.write).toBe(false);
  });

  it("returns a reason string even when write is false", () => {
    const result = buildPostCompactionMemoryJudgment({ taskState: makeCompletedTask() });
    expect(typeof result!.reason).toBe("string");
    expect(result!.reason.length).toBeGreaterThan(0);
  });

  it("does not include suggested_entry when write is false", () => {
    const result = buildPostCompactionMemoryJudgment({ taskState: makeCompletedTask() });
    expect(result!.suggested_entry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildPostCompactionMemoryJudgment — positive signals produce decisions
// ---------------------------------------------------------------------------

describe("buildPostCompactionMemoryJudgment — positive signals", () => {
  it("returns write:true and long_term for userRequestedMemory", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { userRequestedMemory: true },
    });
    expect(result!.write).toBe(true);
    expect(result!.type).toBe("long_term");
    expect(result!.suggested_entry).toBeDefined();
  });

  it("returns write:true and long_term for hasReusableWorkflow", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { hasReusableWorkflow: true },
    });
    expect(result!.write).toBe(true);
    expect(result!.type).toBe("long_term");
  });

  it("returns write:true and long_term for hasUserPreference", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { hasUserPreference: true },
    });
    expect(result!.write).toBe(true);
    expect(result!.type).toBe("long_term");
  });

  it("returns write:true and project for hasPendingFollowUp", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { hasPendingFollowUp: true },
    });
    expect(result!.write).toBe(true);
    expect(result!.type).toBe("project");
  });

  it("returns write:true and project for hasProjectStateChange", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { hasProjectStateChange: true },
    });
    expect(result!.write).toBe(true);
    expect(result!.type).toBe("project");
  });

  it("suggested_entry contains canonical memory section headers", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { userRequestedMemory: true },
    });
    expect(result!.suggested_entry).toContain("背景：");
    expect(result!.suggested_entry).toContain("结论：");
    expect(result!.suggested_entry).toContain("待跟进：");
    expect(result!.suggested_entry).toContain("相关来源：");
  });
});

// ---------------------------------------------------------------------------
// buildPostCompactionMemoryJudgment — safety guards
// ---------------------------------------------------------------------------

describe("buildPostCompactionMemoryJudgment — safety guards", () => {
  it("returns write:false when involvesSensitiveData even with explicit request", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { userRequestedMemory: true, involvesSensitiveData: true },
    });
    expect(result!.write).toBe(false);
    expect(result!.reason).toMatch(/sensitive/i);
  });

  it("returns write:false in group context with personal signal", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { userRequestedMemory: true, isGroupContext: true },
    });
    expect(result!.write).toBe(false);
    expect(result!.reason).toMatch(/group/i);
  });

  it("returns write:false when involvesSensitiveData overrides workflow signal", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { hasReusableWorkflow: true, involvesSensitiveData: true },
    });
    expect(result!.write).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPostCompactionMemoryJudgment — task state variety
// ---------------------------------------------------------------------------

describe("buildPostCompactionMemoryJudgment — task state variety", () => {
  it("works with a pending (not-yet-started) task", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeTask(),
      signals: { hasPendingFollowUp: true },
    });
    expect(result!.write).toBe(true);
    expect(result!.type).toBe("project");
  });

  it("works with a failed task", () => {
    const failedTask = failTask(startTask(makeTask()), "Connection timeout");
    const result = buildPostCompactionMemoryJudgment({
      taskState: failedTask,
      signals: { hasProjectStateChange: true },
    });
    expect(result!.write).toBe(true);
  });

  it("never throws on an empty-field task", () => {
    const bareTask: AgentTaskState = {
      task_id: "",
      title: "",
      goal: "",
      status: "pending",
      owner: "main_agent",
      completed_steps: [],
      pending_steps: [],
      blockers: [],
      sources: [],
      inputs: {},
      outputs: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(() =>
      buildPostCompactionMemoryJudgment({
        taskState: bareTask,
        signals: { userRequestedMemory: true },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: judgment result is suitable for a future writer path
// ---------------------------------------------------------------------------

describe("buildPostCompactionMemoryJudgment — writer-path readiness", () => {
  it("write:true result carries a non-empty suggested_entry", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { hasReusableWorkflow: true },
    });
    expect(result!.write).toBe(true);
    expect(typeof result!.suggested_entry).toBe("string");
    expect(result!.suggested_entry!.length).toBeGreaterThan(0);
  });

  it("write:false result has no suggested_entry (no content to persist)", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
    });
    expect(result!.write).toBe(false);
    expect(result!.suggested_entry).toBeUndefined();
  });

  it("long_term judgment result entry contains long_term marker", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { userRequestedMemory: true },
    });
    expect(result!.suggested_entry).toContain("<!-- 长期记忆 -->");
  });

  it("project judgment result entry contains project marker", () => {
    const result = buildPostCompactionMemoryJudgment({
      taskState: makeCompletedTask(),
      signals: { hasPendingFollowUp: true },
    });
    expect(result!.suggested_entry).toContain("<!-- 项目记忆 -->");
  });
});
