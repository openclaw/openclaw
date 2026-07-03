/**
 * Tests for A2A Task registry.
 */
import { describe, it, expect } from "vitest";
import {
  createTask,
  getTask,
  updateTaskState,
  deleteTask,
  listTasks,
} from "./tasks.js";

describe("task registry", () => {
  it("creates and retrieves a task", () => {
    const task = createTask("agent:main:explicit:123");
    expect(task.id).toBeTruthy();
    expect(task.sessionKey).toBe("agent:main:explicit:123");
    expect(task.state).toBe("working");
    expect(task.createdAt).toBeLessThanOrEqual(Date.now());

    const found = getTask(task.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(task.id);
  });

  it("updates task state", () => {
    const task = createTask("session-key");
    expect(task.state).toBe("working");

    const updated = updateTaskState(task.id, "completed");
    expect(updated!.state).toBe("completed");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);

    const found = getTask(task.id);
    expect(found!.state).toBe("completed");
  });

  it("returns undefined for unknown task", () => {
    expect(getTask("nonexistent")).toBeUndefined();
    expect(updateTaskState("nonexistent", "completed")).toBeUndefined();
  });

  it("deletes a task", () => {
    const task = createTask("key");
    expect(getTask(task.id)).toBeDefined();

    expect(deleteTask(task.id)).toBe(true);
    expect(getTask(task.id)).toBeUndefined();
    expect(deleteTask("nonexistent")).toBe(false);
  });

  it("lists all tasks", () => {
    // Create a few tasks
    createTask("key-a");
    createTask("key-b");
    createTask("key-c");

    const all = listTasks();
    expect(all.length).toBeGreaterThanOrEqual(3);

    // Each task should have unique id
    const ids = new Set(all.map((t) => t.id));
    expect(ids.size).toBe(all.length);
  });

  it("task state transitions", () => {
    const task = createTask("transition-test");

    const validStates = [
      "submitted",
      "working",
      "completed",
      "failed",
      "canceled",
    ] as const;

    for (const state of validStates) {
      const updated = updateTaskState(task.id, state);
      expect(updated!.state).toBe(state);
    }
  });
});
