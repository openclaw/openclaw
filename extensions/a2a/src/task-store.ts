/**
 * File-backed TaskStore for A2A tasks.
 *
 * The @a2a-js/sdk TaskStore interface only requires save() and load().
 * We add cleanup() for periodic removal of expired tasks.
 *
 * Persists each task as a JSON file under {stateDir}/tasks/{taskId}.json
 * so tasks survive gateway restarts.
 */

import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";

export class FileTaskStore implements TaskStore {
  private readonly tasksDir: string;
  private initialized = false;

  constructor(stateDir: string) {
    this.tasksDir = join(stateDir, "tasks");
  }

  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    this.initialized = true;
  }

  private taskPath(taskId: string): string {
    // Sanitize taskId to prevent path traversal
    const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.tasksDir, `${safe}.json`);
  }

  async load(taskId: string): Promise<Task | undefined> {
    await this.ensureDir();
    try {
      const data = await readFile(this.taskPath(taskId), "utf-8");
      return JSON.parse(data) as Task;
    } catch {
      return undefined;
    }
  }

  async save(task: Task): Promise<void> {
    await this.ensureDir();
    const data = JSON.stringify(task, null, 2);
    await writeFile(this.taskPath(task.id), data, { mode: 0o600 });
  }

  /**
   * Remove completed/canceled/failed tasks older than retentionMs.
   * Returns the number of tasks cleaned up.
   */
  async cleanup(retentionMs: number): Promise<number> {
    await this.ensureDir();
    const terminalStates = new Set<string>(["completed", "canceled", "failed"]);
    let files: string[];
    try {
      files = await readdir(this.tasksDir);
    } catch {
      return 0;
    }

    const cutoff = Date.now() - retentionMs;
    let removed = 0;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await readFile(join(this.tasksDir, file), "utf-8");
        const task = JSON.parse(data) as Task;
        if (!task.status || !terminalStates.has(task.status.state)) continue;

        // Use task metadata timestamp if available
        const updatedAt = task.metadata?.updatedAt;
        const taskTime =
          typeof updatedAt === "string"
            ? new Date(updatedAt).getTime()
            : typeof updatedAt === "number"
              ? updatedAt
              : 0;

        if (taskTime > 0 && taskTime < cutoff) {
          await unlink(join(this.tasksDir, file));
          removed++;
        }
      } catch {
        // Skip corrupt files
      }
    }
    return removed;
  }
}
