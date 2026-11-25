import type { WorkerPoolMemoryBudget } from "./worker-task-host.js";

type QueuedTask = {
  options: { pointRead?: boolean };
  hostWaitMs: number;
  hostWaitStartedAt?: number;
  memoryWaitStartedAt?: number;
};

/** A pool's view of host memory admission; the pool keeps its queue and dispatch. */
export function createWorkerTaskPoolMemory(
  maxWorkers: number,
  resolve: () => WorkerPoolMemoryBudget | undefined,
) {
  let budget: WorkerPoolMemoryBudget | undefined;
  // Ordinary workers admitted beyond the floor.
  let growth = 0;
  const bulkLimit = () => (budget ? Math.min(maxWorkers, budget.floor + growth) : maxWorkers);
  return {
    /** Bind the host policy, which can be decided after construction, and release unheld growth. */
    sync(slots: number, closed: boolean): void {
      if (budget && !budget.isCurrent()) {
        // Its reservations left with the replaced policy.
        budget = undefined;
        growth = 0;
      }
      // A closed pool must not join the host's memory ledger again.
      if (!closed) {
        budget ??= resolve();
      }
      // Growth stays reserved until its slot's native exit has been joined.
      const held = budget ? Math.max(0, slots - budget.floor) : 0;
      if (budget && growth > held) {
        budget.releaseGrowth(growth - held);
        growth = held;
      }
    },
    /**
     * The queue head's worker limit. When every admitted ordinary worker is busy, try to admit
     * one more; a refusal leaves the task queued for an existing worker.
     */
    workerLimit(task: QueuedTask, activeTasks: number): number {
      const pointRead = task.options.pointRead === true;
      if (budget && !pointRead && activeTasks >= bulkLimit() && bulkLimit() < maxWorkers) {
        if (budget.admitGrowth()) {
          growth++;
        } else if (task.memoryWaitStartedAt === undefined) {
          task.memoryWaitStartedAt = performance.now();
          budget.waitStarted();
        }
      }
      // One worker beyond the bulk limit stays reserved for point reads.
      return bulkLimit() + Number(pointRead);
    },
    dispatched(task: QueuedTask, slots: number): void {
      finishWorkerTaskWaits(task, budget);
      // A slot beyond floor and growth can only be the mandatory point-read lane.
      if (budget && slots > budget.floor + growth) {
        budget.reservePointReadFloor();
      }
    },
    get budget() {
      return budget;
    },
  };
}

/** End host-exchange and memory waits once a task proceeds or settles. */
export function finishWorkerTaskWaits(task: QueuedTask, budget?: WorkerPoolMemoryBudget): void {
  const now = performance.now();
  if (task.hostWaitStartedAt !== undefined) {
    task.hostWaitMs += now - task.hostWaitStartedAt;
    task.hostWaitStartedAt = undefined;
  }
  if (task.memoryWaitStartedAt !== undefined) {
    budget?.waitFinished(now - task.memoryWaitStartedAt);
    task.memoryWaitStartedAt = undefined;
  }
}
