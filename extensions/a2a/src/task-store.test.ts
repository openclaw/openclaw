import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTaskStore } from "./task-store.js";

describe("FileTaskStore", () => {
  let stateDir: string;
  let store: FileTaskStore;

  beforeEach(async () => {
    stateDir = join(tmpdir(), `a2a-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(stateDir, { recursive: true });
    store = new FileTaskStore(stateDir);
  });

  afterEach(async () => {
    // Cleanup temp directory
    try {
      const tasksDir = join(stateDir, "tasks");
      const files = await readdir(tasksDir).catch(() => []);
      for (const f of files) {
        await unlink(join(tasksDir, f)).catch(() => {});
      }
    } catch {
      // ignore
    }
  });

  it("creates tasks dir on first operation", async () => {
    const task = { id: "task-1", status: { state: "working" as const } };
    await store.save(task as never);

    const tasksDir = join(stateDir, "tasks");
    const files = await readdir(tasksDir);
    expect(files).toContain("task-1.json");
  });

  it("saves and loads a task", async () => {
    const task = {
      id: "task-abc",
      status: { state: "completed" as const },
      metadata: { updatedAt: new Date().toISOString() },
    };

    await store.save(task as never);
    const loaded = await store.load("task-abc");

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe("task-abc");
    expect(loaded!.status!.state).toBe("completed");
  });

  it("returns undefined for non-existent task", async () => {
    const loaded = await store.load("does-not-exist");
    expect(loaded).toBeUndefined();
  });

  it("overwrites existing task on save", async () => {
    const task1 = { id: "task-1", status: { state: "working" as const } };
    const task2 = { id: "task-1", status: { state: "completed" as const } };

    await store.save(task1 as never);
    await store.save(task2 as never);

    const loaded = await store.load("task-1");
    expect(loaded!.status!.state).toBe("completed");
  });

  it("sanitizes task IDs to prevent path traversal", async () => {
    const task = { id: "../../../etc/passwd", status: { state: "working" as const } };
    await store.save(task as never);

    // Should not create a file outside tasks dir
    const tasksDir = join(stateDir, "tasks");
    const files = await readdir(tasksDir);
    expect(files.length).toBe(1);
    // ID should be sanitized
    expect(files[0]).toMatch(/^[a-zA-Z0-9_-]+\.json$/);
  });

  describe("cleanup", () => {
    it("removes completed tasks older than retention", async () => {
      const oldTimestamp = new Date(Date.now() - 100_000).toISOString();
      const task = {
        id: "old-task",
        status: { state: "completed" as const },
        metadata: { updatedAt: oldTimestamp },
      };

      await store.save(task as never);
      const removed = await store.cleanup(50_000); // 50s retention
      expect(removed).toBe(1);

      const loaded = await store.load("old-task");
      expect(loaded).toBeUndefined();
    });

    it("keeps tasks within retention period", async () => {
      const recentTimestamp = new Date().toISOString();
      const task = {
        id: "recent-task",
        status: { state: "completed" as const },
        metadata: { updatedAt: recentTimestamp },
      };

      await store.save(task as never);
      const removed = await store.cleanup(86_400_000); // 24h retention
      expect(removed).toBe(0);

      const loaded = await store.load("recent-task");
      expect(loaded).toBeDefined();
    });

    it("keeps tasks in non-terminal states", async () => {
      const oldTimestamp = new Date(Date.now() - 100_000).toISOString();
      const task = {
        id: "working-task",
        status: { state: "working" as const },
        metadata: { updatedAt: oldTimestamp },
      };

      await store.save(task as never);
      const removed = await store.cleanup(50_000);
      expect(removed).toBe(0);
    });

    it("removes failed and canceled tasks", async () => {
      const old = new Date(Date.now() - 100_000).toISOString();

      await store.save({
        id: "failed-task",
        status: { state: "failed" as const },
        metadata: { updatedAt: old },
      } as never);

      await store.save({
        id: "canceled-task",
        status: { state: "canceled" as const },
        metadata: { updatedAt: old },
      } as never);

      const removed = await store.cleanup(50_000);
      expect(removed).toBe(2);
    });

    it("returns 0 when tasks dir is empty", async () => {
      const removed = await store.cleanup(1000);
      expect(removed).toBe(0);
    });
  });
});
