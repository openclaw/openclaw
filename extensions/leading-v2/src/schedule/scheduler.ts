import type { PluginLogger } from "../../api.js";
import { computeNext } from "./compute-next.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { ActionRunner, ScheduledTask } from "./types.js";

const MAX_FAILS = 5;

export interface SchedulerDeps {
  store: ScheduleStore;
  runners: Record<string, ActionRunner>;
  logger: PluginLogger;
  tickIntervalMs?: number; // default 60s
}

/**
 * Background service: every minute, runs due scheduled tasks and reschedules
 * them. Each task's action is dispatched through a registered runner (which
 * submits a backend task → completion notifier → Notifier delivers the result).
 * Reschedules BEFORE running so a slow runner can't be re-entered next tick.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly tickMs: number;

  constructor(private readonly deps: SchedulerDeps) {
    this.tickMs = deps.tickIntervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    this.deps.logger.info(`[LEADING_V2_SCHED] Scheduler started (every ${this.tickMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One scheduling pass. Public for tests; guarded against re-entrancy. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      // Refresh from the durable store first so out-of-process (web frontend)
      // edits/deletes/toggles are honored before we pick due tasks. No-op in
      // JSON mode (single process, no external writers).
      await this.deps.store.reload();
      const due = this.deps.store.due(now);
      for (const task of due) {
        await this.runOne(task, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runOne(task: ScheduledTask, now: number): Promise<void> {
    const { store, runners, logger } = this.deps;
    // Reschedule first so a long-running submit can't be picked up again next tick.
    const nextRunAt = computeNext(task.schedule, now, task.tz);
    store.update(task.id, { nextRunAt, lastRunAt: now });

    const runner = runners[task.action.tool];
    if (!runner) {
      logger.warn(`[LEADING_V2_SCHED] No runner for action ${task.action.tool} (task ${task.id})`);
      return;
    }
    try {
      const result = await runner(task);
      if (result.ok) {
        if (task.failCount > 0) {
          store.update(task.id, { failCount: 0 });
        }
        logger.info(`[LEADING_V2_SCHED] Ran ${task.id} (${task.title}); next ${new Date(nextRunAt).toISOString()}`);
      } else {
        this.recordFail(task, result.note ?? "runner returned ok=false");
      }
    } catch (error) {
      this.recordFail(task, String(error));
    }
  }

  private recordFail(task: ScheduledTask, note: string): void {
    const { store, logger } = this.deps;
    const failCount = (store.get(task.id)?.failCount ?? task.failCount) + 1;
    const disable = failCount >= MAX_FAILS;
    store.update(task.id, { failCount, ...(disable ? { enabled: false } : {}) });
    logger.warn(
      `[LEADING_V2_SCHED] Task ${task.id} failed (${failCount}/${MAX_FAILS}): ${note}` +
        (disable ? " — auto-disabled" : ""),
    );
  }
}
