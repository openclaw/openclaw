import type { WorkflowJobRecord, WorkflowJobResult, WorkflowRetryPolicy } from "./job-types.js";
import type { WorkflowQueue } from "./queue.js";
import { DEFAULT_WORKFLOW_RETRY_POLICY, computeRetryDelayMs, shouldRetryJob } from "./retry-policy.js";

export interface WorkflowJobHandler {
  run(job: WorkflowJobRecord): Promise<WorkflowJobResult>;
}

export type WorkflowWorkerLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

const noop = (): void => {};
const NOOP_LOGGER: WorkflowWorkerLogger = {
  info: noop,
  warn: noop,
  error: noop,
};

export class WorkflowWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      workerId: string;
      queue: WorkflowQueue;
      handler: WorkflowJobHandler;
      retryPolicy?: WorkflowRetryPolicy;
      pollIntervalMs?: number;
      leaseMs?: number;
      logger?: WorkflowWorkerLogger;
      now?: () => number;
    },
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    const pollIntervalMs = this.deps.pollIntervalMs ?? 500;
    this.timer = setTimeout(() => this.tick(), Math.max(10, pollIntervalMs));
  }

  private async tick(): Promise<void> {
    const logger = this.deps.logger ?? NOOP_LOGGER;
    const nowFn = this.deps.now ?? (() => Date.now());
    const retryPolicy = this.deps.retryPolicy ?? DEFAULT_WORKFLOW_RETRY_POLICY;
    try {
      const job = await this.deps.queue.leaseNext({
        workerId: this.deps.workerId,
        leaseMs: this.deps.leaseMs ?? 30_000,
        now: nowFn(),
      });
      if (!job) {
        this.scheduleNext();
        return;
      }
      await this.deps.queue.markStatus({
        id: job.id,
        status: "running",
        attempts: job.attempts + 1,
      });
      const result = await this.deps.handler.run(job);
      if (result.ok) {
        await this.deps.queue.markStatus({ id: job.id, status: "succeeded" });
        logger.info("workflow: job succeeded", { jobId: job.id, workerId: this.deps.workerId });
      } else {
        const next = {
          ...job,
          attempts: job.attempts + 1,
        };
        if (shouldRetryJob({ job: next, policy: retryPolicy })) {
          const delayMs = computeRetryDelayMs({ attempt: next.attempts, policy: retryPolicy });
          await this.deps.queue.markStatus({
            id: job.id,
            status: "retrying",
            attempts: next.attempts,
            availableAt: nowFn() + delayMs,
            lastError: result.error ?? result.summary,
          });
          logger.warn("workflow: job retry scheduled", {
            jobId: job.id,
            workerId: this.deps.workerId,
            attempts: next.attempts,
            delayMs,
          });
        } else {
          await this.deps.queue.markStatus({
            id: job.id,
            status: "failed",
            attempts: next.attempts,
            lastError: result.error ?? result.summary,
          });
          logger.error("workflow: job failed", {
            jobId: job.id,
            workerId: this.deps.workerId,
            attempts: next.attempts,
          });
        }
      }
    } catch (error) {
      logger.error("workflow: worker tick error", {
        workerId: this.deps.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.scheduleNext();
    }
  }
}

