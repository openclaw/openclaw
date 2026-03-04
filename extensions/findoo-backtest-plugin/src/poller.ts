import type { BacktestClient } from "./backtest-client.js";
import type { RemoteReport, RemoteTask, TaskStatus } from "./types.js";
import { TERMINAL_STATUSES } from "./types.js";

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

export interface PollResult {
  task: RemoteTask;
  report?: RemoteReport;
}

/**
 * Poll a backtest task until it reaches a terminal status or times out.
 *
 * Returns the final task + report (if completed).
 * Throws on timeout or if the task fails.
 */
export async function pollUntilDone(
  client: BacktestClient,
  taskId: string,
  opts: PollOptions,
): Promise<PollResult> {
  const deadline = Date.now() + opts.timeoutMs;

  while (true) {
    const task = await client.getTask(taskId);

    if (TERMINAL_STATUSES.has(task.status)) {
      if (task.status === "failed") {
        throw new Error(`Backtest failed: ${task.message ?? task.error ?? "unknown error"}`);
      }

      if (task.status === "rejected") {
        throw new Error(
          `Backtest rejected: ${task.reject_reason ?? task.error ?? "unknown reason"}`,
        );
      }

      if (task.status === "cancelled") {
        return { task };
      }

      // completed — fetch report
      const report = await client.getReport(taskId);
      return { task, report };
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Backtest poll timeout after ${opts.timeoutMs}ms (task ${taskId} still ${task.status})`,
      );
    }

    await sleep(opts.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exported for testing
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
