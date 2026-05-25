import { randomUUID } from "node:crypto";
import type { A2aTask, A2aTaskSendRequest, A2aTaskStatus } from "./types.js";

export type A2aTaskObserver = (task: A2aTask, delta?: { type: string; data: unknown }) => void;

export class A2aTaskStore {
  private readonly tasks = new Map<string, A2aTask>();
  private readonly observers = new Map<string, Set<A2aTaskObserver>>();

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
    delta?: { type: string; data: unknown },
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
    this._notifyObservers(taskId, next, delta);
    return next;
  }

  setStatus(taskId: string, status: A2aTaskStatus): A2aTask | undefined {
    return this.update(taskId, { status });
  }

  /** 推送流式 delta（不修改任务状态，只通知观察者） */
  pushDelta(taskId: string, delta: { type: string; data: unknown }): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    this._notifyObservers(taskId, task, delta);
  }

  list(limit = 50): A2aTask[] {
    return [...this.tasks.values()]
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  /** 订阅指定任务的变更通知，返回取消订阅函数 */
  subscribe(taskId: string, observer: A2aTaskObserver): () => void {
    let set = this.observers.get(taskId);
    if (!set) {
      set = new Set();
      this.observers.set(taskId, set);
    }
    set.add(observer);
    return () => {
      set?.delete(observer);
      if (set?.size === 0) {
        this.observers.delete(taskId);
      }
    };
  }

  private _notifyObservers(
    taskId: string,
    task: A2aTask,
    delta?: { type: string; data: unknown },
  ): void {
    const set = this.observers.get(taskId);
    if (!set) {
      return;
    }
    for (const obs of set) {
      try {
        obs(task, delta);
      } catch {
        // 单个观察者异常不影响其他观察者
      }
    }
  }
}
