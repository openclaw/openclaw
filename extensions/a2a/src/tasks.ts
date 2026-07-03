/**
 * A2A Task management — maps A2A tasks to OpenClaw sessions.
 *
 * Task lifecycle:
 *   submitted → working → completed / failed / canceled
 *
 * OpenClaw sessions don't have a native task state machine, so we
 * track state in a sidecar Map and infer from session activity.
 */
import { randomUUID } from "node:crypto";

// ── types ──────────────────────────────────────────────────────────────

export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface A2ATask {
  id: string;
  sessionKey: string;
  state: A2ATaskState;
  createdAt: number;
  updatedAt: number;
}

// ── in-memory store ────────────────────────────────────────────────────

const tasks = new Map<string, A2ATask>();

// ── public API ─────────────────────────────────────────────────────────

export function createTask(sessionKey: string): A2ATask {
  const id = randomUUID();
  const now = Date.now();
  const task: A2ATask = {
    id,
    sessionKey,
    state: "working",
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(id, task);
  return task;
}

export function getTask(taskId: string): A2ATask | undefined {
  return tasks.get(taskId);
}

export function updateTaskState(
  taskId: string,
  state: A2ATaskState,
): A2ATask | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  task.state = state;
  task.updatedAt = Date.now();
  return task;
}

export function deleteTask(taskId: string): boolean {
  return tasks.delete(taskId);
}

export function listTasks(): A2ATask[] {
  return [...tasks.values()];
}
