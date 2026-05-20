import { randomUUID } from "node:crypto";
import type { A2aTask, A2aTaskSendRequest, A2aTaskStatus } from "./types.js";

export class A2aTaskStore {
  private readonly tasks = new Map<string, A2aTask>();

  create(req: A2aTaskSendRequest): A2aTask {
    const now = new Date().toISOString();
    const task: A2aTask = {
      id: randomUUID(),
      status: "submitted",
      createdAt: now,
      updatedAt: now,
      message: req.message,
      metadata: req.metadata,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(taskId: string): A2aTask | undefined {
    return this.tasks.get(taskId);
  }

  update(
    taskId: string,
    patch: Partial<Pick<A2aTask, "status" | "result" | "error">>,
  ): A2aTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }
    const next: A2aTask = {
      ...task,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, next);
    return next;
  }

  setStatus(taskId: string, status: A2aTaskStatus): A2aTask | undefined {
    return this.update(taskId, { status });
  }

  list(limit = 50): A2aTask[] {
    return [...this.tasks.values()]
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
}
