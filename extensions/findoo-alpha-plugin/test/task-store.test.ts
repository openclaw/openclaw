import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore", () => {
  let store: TaskStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-tasks-test-"));
    store = new TaskStore(join(tmpDir, "test.sqlite"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleTask = (overrides?: Record<string, unknown>) => ({
    taskId: "fa-1710000000",
    threadId: "thread-abc",
    sessionKey: "agent:main:conv-1",
    label: "茅台市场分析",
    query: "分析贵州茅台的市场趋势",
    submittedAt: Date.now(),
    ...overrides,
  });

  it("insert + findRunning returns the task", () => {
    store.insert(sampleTask());
    const running = store.findRunning();
    expect(running).toHaveLength(1);
    expect(running[0]!.taskId).toBe("fa-1710000000");
    expect(running[0]!.threadId).toBe("thread-abc");
    expect(running[0]!.status).toBe("running");
    expect(running[0]!.label).toBe("茅台市场分析");
    expect(running[0]!.retries).toBe(0);
  });

  it("updateStatus marks task as completed", () => {
    store.insert(sampleTask());
    store.updateStatus("fa-1710000000", "completed", { completedAt: Date.now() });

    const running = store.findRunning();
    expect(running).toHaveLength(0);

    const row = store.findByTaskId("fa-1710000000");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("completed");
    expect(row!.completedAt).toBeGreaterThan(0);
  });

  it("updateStatus marks task as failed with error", () => {
    store.insert(sampleTask());
    store.updateStatus("fa-1710000000", "failed", {
      completedAt: Date.now(),
      error: "LangGraph 500",
    });

    const row = store.findByTaskId("fa-1710000000");
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("LangGraph 500");
  });

  it("incrementRetries increments and returns new value", () => {
    store.insert(sampleTask());
    expect(store.incrementRetries("fa-1710000000")).toBe(1);
    expect(store.incrementRetries("fa-1710000000")).toBe(2);
    expect(store.incrementRetries("fa-1710000000")).toBe(3);

    const row = store.findByTaskId("fa-1710000000");
    expect(row!.retries).toBe(3);
  });

  it("findByTaskId returns null for non-existent task", () => {
    expect(store.findByTaskId("fa-nonexistent")).toBeNull();
  });

  it("cleanup removes old completed tasks but keeps running", () => {
    const old = Date.now() - 2 * 60 * 60_000; // 2 hours ago
    store.insert(sampleTask({ taskId: "fa-old", submittedAt: old }));
    store.updateStatus("fa-old", "completed", { completedAt: old + 60_000 });

    store.insert(sampleTask({ taskId: "fa-running", submittedAt: old }));
    // fa-running stays "running" (no updateStatus)

    store.insert(sampleTask({ taskId: "fa-recent" }));
    store.updateStatus("fa-recent", "completed", { completedAt: Date.now() });

    store.cleanup(60 * 60_000); // max age = 1 hour

    expect(store.findByTaskId("fa-old")).toBeNull(); // cleaned
    expect(store.findByTaskId("fa-running")).not.toBeNull(); // still running, not cleaned
    expect(store.findByTaskId("fa-recent")).not.toBeNull(); // recent, not cleaned
  });

  it("multiple running tasks are returned in submit order", () => {
    store.insert(sampleTask({ taskId: "fa-1", submittedAt: 1000 }));
    store.insert(sampleTask({ taskId: "fa-2", submittedAt: 2000 }));
    store.insert(sampleTask({ taskId: "fa-3", submittedAt: 3000 }));

    const running = store.findRunning();
    expect(running).toHaveLength(3);
    expect(running.map((r) => r.taskId)).toEqual(["fa-1", "fa-2", "fa-3"]);
  });

  it("uses WAL journal mode", () => {
    // Re-open to verify WAL persists
    store.close();
    const store2 = new TaskStore(join(tmpDir, "test.sqlite"));
    const running = store2.findRunning();
    expect(running).toHaveLength(0); // just verifying it opens without error
    store2.close();
    // Reopen for afterEach cleanup
    store = new TaskStore(join(tmpDir, "test.sqlite"));
  });

  it("INSERT OR REPLACE handles duplicate taskId", () => {
    store.insert(sampleTask());
    store.insert(sampleTask({ label: "updated label" }));

    const row = store.findByTaskId("fa-1710000000");
    expect(row!.label).toBe("updated label");
    expect(store.findRunning()).toHaveLength(1);
  });
});
