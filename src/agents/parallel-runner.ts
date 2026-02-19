export interface ParallelTask {
  id: string;
  message: string;
  sessionKey: string;
  agentId?: string;
  priority?: "high" | "medium" | "low";
}

export interface ParallelTaskResult {
  taskId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export class ParallelTaskRunner {
  private maxParallel: number;

  constructor(maxParallel: number = 5) {
    this.maxParallel = Math.min(maxParallel, 10);
  }

  async run<T>(
    tasks: ParallelTask[],
    executor: (task: ParallelTask) => Promise<T>,
  ): Promise<ParallelTaskResult[]> {
    const results: ParallelTaskResult[] = [];
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
      const promise = this.executeTask(task, executor).then((result) => {
        results.push(result);
      });

      executing.push(promise);

      if (executing.length >= this.maxParallel) {
        await Promise.race(executing);
        const completed = executing.filter(
          (p) => (p as unknown as { status: string }).status === "fulfilled",
        );
        executing.splice(0, completed.length);
      }
    }

    await Promise.allSettled(executing);
    return results;
  }

  private async executeTask<T>(
    task: ParallelTask,
    executor: (task: ParallelTask) => Promise<T>,
  ): Promise<ParallelTaskResult> {
    const startTime = Date.now();

    try {
      const result = await executor(task);
      return {
        taskId: task.id,
        success: true,
        result,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        error: String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  detectParallelTasks(message: string): string[] {
    return this.detectTasks(message);
  }

  detectTasks(message: string): string[] {
    const separators = [/&&&/g, /\|\|\|/g, /\n---\n/g, /===TASK\d+===/g];

    const tasks: string[] = [];

    for (const pattern of separators) {
      const matches = message.split(pattern);
      if (matches.length > 1) {
        tasks.push(...matches.filter((m) => m.trim()));
        break;
      }
    }

    const numberedPattern = /^(?:\d+[.)]\s+)/gm;
    if (tasks.length === 0 && numberedPattern.test(message)) {
      const lines = message.split("\n");
      let currentTask = "";

      for (const line of lines) {
        if (/^(?:\d+[.)]\s+)/.test(line)) {
          if (currentTask) {
            tasks.push(currentTask.trim());
          }
          currentTask = line.replace(numberedPattern, "").trim();
        } else if (currentTask) {
          currentTask += "\n" + line;
        }
      }

      if (currentTask) {
        tasks.push(currentTask.trim());
      }
    }

    return tasks;
  }
}
