import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CcRelayConfig } from "./config.js";
import { ProgressReporter, type ProgressReporterCallbacks } from "./progress-reporter.js";
import { runCcWorker, type WorkerResult } from "./worker.js";
import type { CcRelayJob } from "./types.js";

/**
 * The dispatcher manages a serial queue of Claude Code tasks.
 *
 * This is the TypeScript equivalent of T800's `dispatch.sh + worker.sh` combo:
 * - Accepts new tasks and queues them
 * - Runs one task at a time to avoid Claude session conflicts
 * - Starts a progress reporter for each running task
 * - Calls back with results for the caller to deliver to the channel
 */

export interface DispatchParams {
  prompt: string;
  taskName?: string;
  channel: string;
  target: string;
  workdir?: string;
  fresh?: boolean;
}

export interface DispatcherCallbacks {
  /** Send a text message to a channel target. */
  sendMessage: (channel: string, target: string, text: string) => Promise<void>;
  /** Send a file attachment to a channel target. */
  sendFile: (channel: string, target: string, filePath: string, fileName: string) => Promise<void>;
  /** Called when a job completes. */
  onComplete?: (job: CcRelayJob, result: WorkerResult) => void;
}

export class CcRelayDispatcher {
  private queue: CcRelayJob[] = [];
  private running: CcRelayJob | null = null;
  private processing = false;

  constructor(
    private readonly cfg: CcRelayConfig,
    private readonly callbacks: DispatcherCallbacks,
  ) {}

  /**
   * Dispatch a new task. Returns immediately; execution happens in background.
   */
  dispatch(params: DispatchParams): CcRelayJob {
    // Prevent unbounded queue growth
    if (this.queue.length >= 50) {
      throw new Error("cc-relay queue is full (50 tasks). Wait for existing tasks to complete.");
    }

    const job: CcRelayJob = {
      id: randomUUID(),
      taskName: params.taskName ?? `task-${Date.now()}`,
      prompt: params.prompt,
      channel: params.channel,
      target: params.target,
      workdir: params.workdir || this.cfg.workdir,
      permissionMode: this.cfg.permissionMode,
      model: this.cfg.model,
      fresh: params.fresh ?? false,
      timeoutSeconds: this.cfg.timeoutSeconds,
      createdAt: new Date().toISOString(),
      status: "queued",
    };

    this.queue.push(job);
    void this.processQueue();
    return job;
  }

  /** Get the currently running job, if any. */
  getRunning(): CcRelayJob | null {
    return this.running;
  }

  /** Get queued jobs. */
  getQueue(): readonly CcRelayJob[] {
    return this.queue;
  }

  /** Stop processing and clear the queue. */
  stop(): void {
    this.queue = [];
    this.processing = false;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running = job;
      job.status = "running";

      // Start progress reporter
      const reporter = new ProgressReporter(job, this.cfg, {
        sendMessage: this.callbacks.sendMessage,
      });
      reporter.start();

      let result: WorkerResult;
      try {
        result = await runCcWorker(job, this.cfg);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result = { exitCode: 1, resultText: `Error: ${message}`, newFiles: [], durationMs: 0 };
      }

      reporter.stop();

      // Update job status
      job.exitCode = result.exitCode;
      job.completedAt = new Date().toISOString();
      job.status = result.exitCode === 0 ? "completed" : result.exitCode === 124 ? "timeout" : "failed";
      job.newFiles = result.newFiles;

      // Deliver results
      await this.deliverResults(job, result);

      this.callbacks.onComplete?.(job, result);
      this.running = null;
    }

    this.processing = false;
  }

  private async deliverResults(job: CcRelayJob, result: WorkerResult): Promise<void> {
    if (!job.target) return;

    // Send the main result text
    let text = result.resultText;
    if (text.length > this.cfg.maxResultChars) {
      text = "...\n\n" + text.slice(-this.cfg.maxResultChars);
    }
    if (text) {
      await this.callbacks.sendMessage(job.channel, job.target, text);
    }

    // Send new/modified files as attachments
    for (const filePath of result.newFiles) {
      const fileName = path.basename(filePath);
      try {
        await this.callbacks.sendFile(job.channel, job.target, filePath, fileName);
      } catch {
        /* attachment delivery is best-effort */
      }
    }

    // If result was truncated, send the full text as a .md file
    if (result.resultText.length > this.cfg.maxResultChars) {
      const tmpPath = path.join(job.workdir, `.cc-relay-output-${job.id.slice(0, 8)}.md`);
      try {
        fs.writeFileSync(tmpPath, result.resultText, "utf-8");
        await this.callbacks.sendFile(job.channel, job.target, tmpPath, "full-output.md");
      } catch {
        /* best-effort */
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  }
}
