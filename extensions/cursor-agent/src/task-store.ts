/**
 * In-memory task store for correlating Cursor Agent tasks with OpenClaw sessions.
 *
 * This store maps Cursor Agent task IDs to OpenClaw session keys,
 * allowing webhook responses to be routed back to the correct session.
 */

import type { CursorAgentTask } from "./types.js";

// In-memory store (could be replaced with persistent storage)
const taskStore = new Map<string, CursorAgentTask>();

// Cleanup interval for old tasks (1 hour)
const TASK_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * Get the task store singleton.
 */
export function getTaskStore(): Map<string, CursorAgentTask> {
  // Start cleanup timer if not running
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupOldTasks, CLEANUP_INTERVAL_MS);
    // Don't block process exit
    cleanupTimer.unref();
  }
  return taskStore;
}

/**
 * Get a task by ID.
 */
export function getTask(taskId: string): CursorAgentTask | undefined {
  return taskStore.get(taskId);
}

/**
 * Store a task.
 */
export function setTask(task: CursorAgentTask): void {
  taskStore.set(task.id, task);
}

/**
 * Update a task.
 */
export function updateTask(
  taskId: string,
  updates: Partial<CursorAgentTask>,
): CursorAgentTask | null {
  const existing = taskStore.get(taskId);
  if (!existing) {
    return null;
  }

  const updated = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };
  taskStore.set(taskId, updated);
  return updated;
}

/**
 * Delete a task.
 */
export function deleteTask(taskId: string): boolean {
  return taskStore.delete(taskId);
}

/**
 * Get all tasks for a session.
 */
export function getTasksForSession(sessionKey: string): CursorAgentTask[] {
  const tasks: CursorAgentTask[] = [];
  for (const task of taskStore.values()) {
    if (task.sessionKey === sessionKey) {
      tasks.push(task);
    }
  }
  return tasks;
}

/**
 * Get all pending tasks.
 */
export function getPendingTasks(): CursorAgentTask[] {
  const tasks: CursorAgentTask[] = [];
  for (const task of taskStore.values()) {
    if (task.status === "PENDING" || task.status === "RUNNING") {
      tasks.push(task);
    }
  }
  return tasks;
}

/**
 * Clean up old completed/failed tasks.
 */
function cleanupOldTasks(): void {
  const now = Date.now();
  const keysToDelete: string[] = [];

  for (const [key, task] of taskStore.entries()) {
    // Keep pending/running tasks regardless of age
    if (task.status === "PENDING" || task.status === "RUNNING") {
      continue;
    }

    // Delete completed/failed tasks older than TTL
    if (now - task.updatedAt > TASK_TTL_MS) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    taskStore.delete(key);
  }
}

/**
 * Stop the cleanup timer (for testing/shutdown).
 */
export function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Clear all tasks (for testing).
 */
export function clearTasks(): void {
  taskStore.clear();
}
