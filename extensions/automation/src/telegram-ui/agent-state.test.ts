import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSystemStateForTest,
  __setRuntimeStartedAtForTest,
  completeTask,
  getSystemState,
  setActiveTask,
} from "./agent-state.js";

describe("telegram-ui agent state", () => {
  beforeEach(() => {
    __resetSystemStateForTest();
  });

  it("derives uptime from runtime start timestamp", () => {
    __setRuntimeStartedAtForTest(1000);
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(2500);
    expect(getSystemState().stats.uptime).toBe(1500);
    nowSpy.mockReturnValue(4000);
    expect(getSystemState().stats.uptime).toBe(3000);
    nowSpy.mockRestore();
  });

  it("completes active task and increments tasksToday", () => {
    setActiveTask({
      id: "task-1",
      title: "測試任務",
      phase: "coding",
      agent: "codex",
      startedAt: Date.now(),
      stepCurrent: 1,
      stepTotal: 3,
      currentAction: "編寫中",
    });
    completeTask(true);
    const state = getSystemState();
    expect(state.activeTask).toBeNull();
    expect(state.phase).toBe("idle");
    expect(state.stats.tasksToday).toBe(1);
    expect(state.lastCompletedTask?.title).toBe("測試任務");
    expect(state.lastCompletedTask?.success).toBe(true);
  });
});
