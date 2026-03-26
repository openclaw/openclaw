/** Task executor — full lifecycle: claim, plan, execute in worktree, report. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claimTask } from "./claim-arbitrator.js";
import type { Task, TaskBackend, WorkerConfig } from "./types.js";
import { WorktreeManager } from "./worktree-manager.js";

const execFileAsync = promisify(execFile);

export class TaskExecutor {
  private activeTasks = 0;
  private readonly worktreeManager: WorktreeManager;

  constructor(
    private readonly config: WorkerConfig,
    private readonly backend: TaskBackend,
  ) {
    this.worktreeManager = new WorktreeManager(config.worktreeBaseDir, config.repoDir);
  }

  get activeCount(): number {
    return this.activeTasks;
  }

  get canAcceptTask(): boolean {
    return this.activeTasks < this.config.maxThreads;
  }

  async tryExecute(task: Task): Promise<void> {
    if (!this.canAcceptTask) return;

    // Attempt claim
    const claimed = await claimTask(task, this.config.nodeName, this.backend);
    if (!claimed) return;

    this.activeTasks++;
    try {
      await this.executeTask(task);
    } finally {
      this.activeTasks--;
    }
  }

  private async executeTask(task: Task): Promise<void> {
    let worktreePath: string | null = null;

    try {
      // Create worktree
      worktreePath = await this.worktreeManager.create(task.id);

      // Execute using Claude Code CLI in the worktree
      const prompt = `Task: ${task.title}\n\nDescription: ${task.description}`;
      const escapedPrompt = prompt.replace(/'/g, "'\\''");

      const { stdout, stderr } = await execFileAsync(
        "claude",
        ["-p", prompt, "--output-format", "text"],
        {
          cwd: worktreePath,
          timeout: 600_000, // 10 minute timeout
          env: { ...process.env, CLAUDE_WORKTREE: worktreePath },
        },
      );

      // Push branch
      await this.worktreeManager.pushBranch(task.id).catch(() => {
        // Push failure is non-fatal for some tasks
      });

      // Mark done
      await this.backend.updateTaskStatus(task.id, "done", {
        completed_at: new Date().toISOString(),
        output_length: String(stdout.length),
      });
    } catch (err) {
      // Mark failed
      await this.backend.updateTaskStatus(task.id, "failed", {
        failed_at: new Date().toISOString(),
        error: String(err).slice(0, 2000),
      });
    } finally {
      // Cleanup worktree
      if (worktreePath) {
        await this.worktreeManager.remove(task.id).catch(() => {});
      }
    }
  }

  /** Recover from crash: clean up stale worktrees and mark orphaned tasks as failed. */
  async recoverStale(): Promise<string[]> {
    const staleIds = await this.worktreeManager.cleanupStale(2);
    for (const taskId of staleIds) {
      await this.backend.updateTaskStatus(taskId, "failed", {
        failed_at: new Date().toISOString(),
        error: "Crash recovery: stale worktree cleaned up",
      });
    }
    return staleIds;
  }
}
