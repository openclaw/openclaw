import { v4 as uuidv4 } from "uuid";
import {
  getDueSchedules,
  markScheduleRun,
  createTask,
  getEmployee,
  logActivity,
  type EmployeeSchedule,
} from "./db";

// ---------------------------------------------------------------------------
// Cron parsing utility
// ---------------------------------------------------------------------------
// Supports standard 5-field cron: minute hour day-of-month month day-of-week
//   Field          Allowed values
//   minute         0-59
//   hour           0-23
//   day-of-month   1-31
//   month          1-12 (or *)
//   day-of-week    0-7 (0 and 7 = Sunday), ranges like 1-5
//
// Supported syntax per field: number, *, ranges (1-5), no step/list support.
// This is intentionally minimal — covers the patterns used by employee schedules.
// ---------------------------------------------------------------------------

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function expandField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const out: number[] = [];
    for (let i = min; i <= max; i++) {out.push(i);}
    return out;
  }

  // Range: e.g. "1-5"
  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end)) {throw new Error(`Invalid cron range: ${field}`);}
    const out: number[] = [];
    for (let i = start; i <= end; i++) {out.push(i);}
    return out;
  }

  // Single number
  const num = parseInt(field, 10);
  if (isNaN(num)) {throw new Error(`Invalid cron field: ${field}`);}
  return [num];
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression (need 5 fields): "${expression}"`);
  }

  return {
    minute: expandField(parts[0], 0, 59),
    hour: expandField(parts[1], 0, 23),
    dayOfMonth: expandField(parts[2], 1, 31),
    month: expandField(parts[3], 1, 12),
    dayOfWeek: expandField(parts[4], 0, 7).map((d) => (d === 7 ? 0 : d)), // normalise Sunday
  };
}

/**
 * Compute the next run time from a cron expression in the given timezone.
 * Returns an ISO 8601 UTC datetime string.
 *
 * We iterate minute-by-minute from `after` (default: now) up to 400 days ahead.
 * The search is capped at ~576,000 iterations (400 days * 24h * 60m) which is
 * perfectly fine for a server-side utility that runs once per tick.
 */
export function computeNextRun(
  cronExpression: string,
  timezone: string,
  after?: Date
): string {
  const fields = parseCron(cronExpression);
  const start = after ?? new Date();

  // Advance to the beginning of the next minute
  const cursor = new Date(start.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const MAX_ITERATIONS = 400 * 24 * 60; // ~400 days

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Format the cursor in the target timezone to extract local components
    const localeStr = cursor.toLocaleString("en-US", { timeZone: timezone });
    const local = new Date(localeStr);

    const minute = local.getMinutes();
    const hour = local.getHours();
    const dayOfMonth = local.getDate();
    const month = local.getMonth() + 1; // 1-indexed
    const dayOfWeek = local.getDay(); // 0 = Sunday

    if (
      fields.minute.includes(minute) &&
      fields.hour.includes(hour) &&
      fields.dayOfMonth.includes(dayOfMonth) &&
      fields.month.includes(month) &&
      fields.dayOfWeek.includes(dayOfWeek)
    ) {
      return cursor.toISOString();
    }

    // Advance by 1 minute
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  // Fallback: should not happen for valid expressions
  throw new Error(
    `Could not compute next run for "${cronExpression}" within 400 days`
  );
}

// ---------------------------------------------------------------------------
// Schedule Engine
// ---------------------------------------------------------------------------

class ScheduleEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly CHECK_INTERVAL_MS = 60_000; // 1 minute

  start(): void {
    if (this.timer) {return;}
    console.log("[ScheduleEngine] Starting scheduler");
    this.timer = setInterval(() => this.tick(), this.CHECK_INTERVAL_MS);
    // Run once immediately
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[ScheduleEngine] Stopped");
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Manually trigger a tick — useful for testing or one-off checks. */
  async manualTick(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running) {return;} // Skip if previous tick still running
    this.running = true;
    try {
      const due = getDueSchedules();
      for (const schedule of due) {
        await this.executeSchedule(schedule);
      }
    } catch (err) {
      console.error("[ScheduleEngine] Tick error:", String(err));
    } finally {
      this.running = false;
    }
  }

  private async executeSchedule(schedule: EmployeeSchedule): Promise<void> {
    try {
      const employee = getEmployee(schedule.employee_id);
      const employeeName = employee?.name || schedule.employee_id;

      // Create task
      const task = createTask({
        id: uuidv4(),
        title: `[Scheduled] ${schedule.title}`,
        description: schedule.description || schedule.title,
        priority: schedule.priority,
        employee_id: schedule.employee_id,
        assigned_agent_id: schedule.agent_id,
        workspace_id: schedule.workspace_id,
        status: "inbox",
      });

      // Log activity
      logActivity({
        id: uuidv4(),
        type: "schedule_triggered",
        task_id: task.id,
        agent_id: schedule.agent_id,
        workspace_id: schedule.workspace_id,
        message: `Scheduled task "${schedule.title}" triggered for ${employeeName}`,
        metadata: { schedule_id: schedule.id, cron: schedule.cron_expression },
      });

      // Update schedule: mark as run and compute next
      const nextRun = computeNextRun(
        schedule.cron_expression,
        schedule.timezone
      );
      markScheduleRun(schedule.id, new Date().toISOString(), nextRun);

      console.log(
        `[ScheduleEngine] Triggered: "${schedule.title}" for ${employeeName}, next: ${nextRun}`
      );
    } catch (err) {
      console.error(
        `[ScheduleEngine] Failed to execute schedule ${schedule.id}:`,
        String(err)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton (survives Next.js HMR via globalThis)
// ---------------------------------------------------------------------------

const globalForScheduler = globalThis as typeof globalThis & {
  __scheduleEngine?: ScheduleEngine;
};

export function getScheduleEngine(): ScheduleEngine {
  if (!globalForScheduler.__scheduleEngine) {
    globalForScheduler.__scheduleEngine = new ScheduleEngine();
  }
  return globalForScheduler.__scheduleEngine;
}
