/**
 * Tests for A2A Task registry.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
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
    assert.ok(task.id);
    assert.strictEqual(task.sessionKey, "agent:main:explicit:123");
    assert.strictEqual(task.state, "working");
    assert.ok(task.createdAt <= Date.now());

    const found = getTask(task.id);
    assert.ok(found);
    assert.strictEqual(found!.id, task.id);
  });

  it("updates task state", () => {
    const task = createTask("session-key");
    assert.strictEqual(task.state, "working");

    const updated = updateTaskState(task.id, "completed");
    assert.strictEqual(updated!.state, "completed");
    assert.ok(updated!.updatedAt >= task.updatedAt);

    const found = getTask(task.id);
    assert.strictEqual(found!.state, "completed");
  });

  it("returns undefined for unknown task", () => {
    assert.strictEqual(getTask("nonexistent"), undefined);
    assert.strictEqual(updateTaskState("nonexistent", "completed"), undefined);
  });

  it("deletes a task", () => {
    const task = createTask("key");
    assert.ok(getTask(task.id));

    assert.strictEqual(deleteTask(task.id), true);
    assert.strictEqual(getTask(task.id), undefined);
    assert.strictEqual(deleteTask("nonexistent"), false);
  });

  it("lists all tasks", () => {
    createTask("key-a");
    createTask("key-b");
    createTask("key-c");

    const all = listTasks();
    assert.ok(all.length >= 3);

    const ids = new Set(all.map((t) => t.id));
    assert.strictEqual(ids.size, all.length);
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
      assert.strictEqual(updated!.state, state);
    }
  });
});
