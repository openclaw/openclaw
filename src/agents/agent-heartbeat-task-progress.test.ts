import { describe, expect, it } from "vitest";
import {
  buildHeartbeatTaskProgressContext,
  buildHeartbeatTaskProgressLine,
} from "./agent-heartbeat-task-progress.js";
import { advanceTaskStep, createTaskState, startTask } from "./agent-task-state.js";

function makeTask() {
  return startTask(
    createTaskState({
      task_id: "heartbeat-task-1",
      title: "Long running task",
      goal: "finish upgrade",
      pending_steps: ["phase a", "phase b", "phase c"],
    }),
  );
}

describe("buildHeartbeatTaskProgressLine", () => {
  it("returns undefined when task state is absent", () => {
    expect(buildHeartbeatTaskProgressLine(undefined)).toBeUndefined();
  });

  it("renders a compact mid-task progress line", () => {
    const task = advanceTaskStep(makeTask(), "phase a");
    const line = buildHeartbeatTaskProgressLine(task);
    expect(line).toContain("Long running task");
    expect(line).toContain("33%");
    expect(line).toContain("1/3 steps");
  });

  it("does not throw for malformed-but-cast task values", () => {
    expect(() => buildHeartbeatTaskProgressLine({} as never)).not.toThrow();
  });
});

describe("buildHeartbeatTaskProgressContext", () => {
  it("returns undefined when task state is absent — backcompat", () => {
    expect(buildHeartbeatTaskProgressContext(undefined)).toBeUndefined();
  });

  it("wraps the progress line in a heartbeat prompt section", () => {
    const context = buildHeartbeatTaskProgressContext(advanceTaskStep(makeTask(), "phase a"));
    expect(context).toContain("## Current Task Progress");
    expect(context).toContain("Long running task");
  });

  it("never throws for malformed-but-cast task values", () => {
    expect(() => buildHeartbeatTaskProgressContext({} as never)).not.toThrow();
  });
});
