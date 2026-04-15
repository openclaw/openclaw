/**
 * Active Memory Scheduler
 * 
 * Schedules memory recalls and reminders at specific times.
 * Useful for time-based memory surfacing and proactive reminders.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface ScheduledRecall {
  scheduleId: string;
  sessionKey: string;
  agentId: string;
  query: string;
  scheduledAt: number;
  triggerTime: number;
  recurrence?: {
    type: "once" | "daily" | "weekly" | "custom";
    intervalMs?: number;
    maxOccurrences?: number;
    occurrencesCompleted?: number;
  };
  status: "pending" | "completed" | "cancelled" | "failed";
  priority: "low" | "normal" | "high" | "urgent";
  contextTags: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  completedAt?: number;
  result?: {
    memoryFound: boolean;
    summary?: string;
    error?: string;
  };
}

export interface ScheduleConfig {
  defaultPriority?: ScheduledRecall["priority"];
  maxSchedulesPerSession?: number;
  maxPendingSchedules?: number;
  cleanupIntervalMs?: number;
  enableNotifications?: boolean;
}

const SCHEDULES_FILE = "scheduled-recalls.json";
const DEFAULT_MAX_SCHEDULES_PER_SESSION = 10;
const DEFAULT_MAX_PENDING_SCHEDULES = 100;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class MemoryScheduler {
  private api: OpenClawPluginApi;
  private config: Required<ScheduleConfig>;
  private schedulesPath: string;
  private schedules: Map<string, ScheduledRecall> = new Map();
  private cleanupTimer?: NodeJS.Timeout;
  private initialized: boolean = false;

  constructor(api: OpenClawPluginApi, config?: ScheduleConfig) {
    this.api = api;
    this.config = {
      defaultPriority: config?.defaultPriority ?? "normal",
      maxSchedulesPerSession: config?.maxSchedulesPerSession ?? DEFAULT_MAX_SCHEDULES_PER_SESSION,
      maxPendingSchedules: config?.maxPendingSchedules ?? DEFAULT_MAX_PENDING_SCHEDULES,
      cleanupIntervalMs: config?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
      enableNotifications: config?.enableNotifications ?? true,
    };

    this.schedulesPath = path.join(
      api.runtime.state.resolveStateDir(),
      "plugins",
      "active-memory",
      SCHEDULES_FILE
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadSchedules();
    this.startCleanupTimer();
    this.initialized = true;

    this.api.logger.info?.("[active-memory] Scheduler initialized");
  }

  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    await this.saveSchedules();
    this.initialized = false;
  }

  private async loadSchedules(): Promise<void> {
    try {
      const raw = await fs.readFile(this.schedulesPath, "utf8");
      const data = JSON.parse(raw) as Record<string, ScheduledRecall>;
      this.schedules = new Map(Object.entries(data));
      this.api.logger.debug?.(`[active-memory] Loaded ${this.schedules.size} schedules`);
    } catch {
      // File doesn't exist, start fresh
      this.schedules = new Map();
    }
  }

  private async saveSchedules(): Promise<void> {
    const data = Object.fromEntries(this.schedules.entries());
    await fs.mkdir(path.dirname(this.schedulesPath), { recursive: true });
    await fs.writeFile(this.schedulesPath, JSON.stringify(data, null, 2));
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldSchedules().catch((err) => {
          this.api.logger.error?.(`[active-memory] Cleanup failed: ${err}`);
      });
    }, this.config.cleanupIntervalMs);

    // Don't block process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  async scheduleRecall(params: {
    sessionKey: string;
    agentId: string;
    query: string;
    triggerTime: Date | number;
    recurrence?: ScheduledRecall["recurrence"];
    priority?: ScheduledRecall["priority"];
    contextTags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; scheduleId?: string; error?: string }> {
    await this.initialize();

    // Check limits
    const sessionSchedules = this.getSessionSchedules(params.sessionKey);
    const pendingSessionSchedules = sessionSchedules.filter((s) => s.status === "pending");
    
    if (pendingSessionSchedules.length >= this.config.maxSchedulesPerSession) {
      return {
        success: false,
        error: `Maximum ${this.config.maxSchedulesPerSession} pending schedules per session reached`,
      };
    }

    const totalPending = Array.from(this.schedules.values()).filter(
      (s) => s.status === "pending"
    ).length;

    if (totalPending >= this.config.maxPendingSchedules) {
      return {
        success: false,
        error: `Maximum ${this.config.maxPendingSchedules} total pending schedules reached`,
      };
    }

    const scheduleId = `sch_${crypto.randomUUID().replace(/-/g, "")}`;
    const triggerTimeMs =
      params.triggerTime instanceof Date
        ? params.triggerTime.getTime()
        : params.triggerTime;

    // Validate trigger time is in the future
    if (triggerTimeMs <= Date.now()) {
      return {
        success: false,
        error: "Trigger time must be in the future",
      };
    }

    const schedule: ScheduledRecall = {
      scheduleId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      query: params.query,
      scheduledAt: Date.now(),
      triggerTime: triggerTimeMs,
      recurrence: params.recurrence,
      status: "pending",
      priority: params.priority ?? this.config.defaultPriority,
      contextTags: params.contextTags ?? [],
      metadata: params.metadata ?? {},
      createdAt: Date.now(),
    };

    this.schedules.set(scheduleId, schedule);
    await this.saveSchedules();

    this.api.logger.info?.(
      `[active-memory] Scheduled recall ${scheduleId} for ${new Date(
        triggerTimeMs
      ).toISOString()}`
    );

    return { success: true, scheduleId };
  }

  async cancelSchedule(scheduleId: string): Promise<boolean> {
    await this.initialize();

    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return false;
    if (schedule.status !== "pending") return false;

    schedule.status = "cancelled";
    schedule.completedAt = Date.now();
    schedule.result = { memoryFound: false, error: "Cancelled by user" };

    await this.saveSchedules();

    this.api.logger.info?.(`[active-memory] Cancelled schedule ${scheduleId}`);

    return true;
  }

  async getDueSchedules(): Promise<ScheduledRecall[]> {
    await this.initialize();

    const now = Date.now();
    const due: ScheduledRecall[] = [];

    for (const schedule of this.schedules.values()) {
      if (schedule.status === "pending" && schedule.triggerTime <= now) {
        due.push(schedule);
      }
    }

    // Sort by priority (urgent > high > normal > low) and then by trigger time
    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    due.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.triggerTime - b.triggerTime;
    });

    return due;
  }

  async markScheduleCompleted(
    scheduleId: string,
    result: { memoryFound: boolean; summary?: string; error?: string }
  ): Promise<void> {
    await this.initialize();

    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return;

    schedule.status = "completed";
    schedule.completedAt = Date.now();
    schedule.result = result;

    // Handle recurrence
    if (schedule.recurrence && schedule.recurrence.type !== "once") {
      const maxOccurrences = schedule.recurrence.maxOccurrences ?? Infinity;
      const currentOccurrences = schedule.recurrence.occurrencesCompleted ?? 0;

      if (currentOccurrences + 1 < maxOccurrences) {
        // Create next occurrence
        let nextTriggerTime: number;

        switch (schedule.recurrence.type) {
          case "daily":
            nextTriggerTime = schedule.triggerTime + 24 * 60 * 60 * 1000;
            break;
          case "weekly":
            nextTriggerTime = schedule.triggerTime + 7 * 24 * 60 * 60 * 1000;
            break;
          case "custom":
            nextTriggerTime =
              schedule.triggerTime + (schedule.recurrence.intervalMs ?? 24 * 60 * 60 * 1000);
            break;
          default:
            nextTriggerTime = schedule.triggerTime + 24 * 60 * 60 * 1000;
        }

        // Create next schedule
        await this.scheduleRecall({
          sessionKey: schedule.sessionKey,
          agentId: schedule.agentId,
          query: schedule.query,
          triggerTime: nextTriggerTime,
          recurrence: {
            ...schedule.recurrence,
            occurrencesCompleted: currentOccurrences + 1,
          },
          priority: schedule.priority,
          contextTags: schedule.contextTags,
          metadata: { ...schedule.metadata, previousScheduleId: scheduleId },
        });
      }
    }

    await this.saveSchedules();

    this.api.logger.info?.(
      `[active-memory] Schedule ${scheduleId} completed: ${
        result.memoryFound ? "memory found" : "no memory"
      }`
    );
  }

  async markScheduleFailed(scheduleId: string, error: string): Promise<void> {
    await this.initialize();

    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return;

    schedule.status = "failed";
    schedule.completedAt = Date.now();
    schedule.result = { memoryFound: false, error };

    await this.saveSchedules();

    this.api.logger.warn?.(`[active-memory] Schedule ${scheduleId} failed: ${error}`);
  }

  getSessionSchedules(sessionKey: string): ScheduledRecall[] {
    return Array.from(this.schedules.values()).filter((s) => s.sessionKey === sessionKey);
  }

  async getPendingSchedules(): Promise<ScheduledRecall[]> {
    await this.initialize();
    return Array.from(this.schedules.values()).filter((s) => s.status === "pending");
  }

  async getScheduleById(scheduleId: string): Promise<ScheduledRecall | undefined> {
    await this.initialize();
    return this.schedules.get(scheduleId);
  }

  private async cleanupOldSchedules(): Promise<number> {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [scheduleId, schedule] of this.schedules.entries()) {
      // Remove completed/cancelled/failed schedules older than a week
      if (
        (schedule.status === "completed" ||
          schedule.status === "cancelled" ||
          schedule.status === "failed") &&
        schedule.completedAt &&
        schedule.completedAt < oneWeekAgo
      ) {
        this.schedules.delete(scheduleId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      await this.saveSchedules();
      this.api.logger.debug?.(`[active-memory] Cleaned up ${cleaned} old schedules`);
    }

    return cleaned;
  }

  async getSchedulerStats(): Promise<{
    totalSchedules: number;
    pending: number;
    completed: number;
    cancelled: number;
    failed: number;
    byPriority: Record<string, number>;
    bySession: Record<string, number>;
    nextDue?: Date;
  }> {
    await this.initialize();

    const stats = {
      totalSchedules: this.schedules.size,
      pending: 0,
      completed: 0,
      cancelled: 0,
      failed: 0,
      byPriority: {} as Record<string, number>,
      bySession: {} as Record<string, number>,
      nextDue: undefined as Date | undefined,
    };

    let earliestDue = Infinity;

    for (const schedule of this.schedules.values()) {
      stats[schedule.status]++;
      stats.byPriority[schedule.priority] = (stats.byPriority[schedule.priority] ?? 0) + 1;
      stats.bySession[schedule.sessionKey] = (stats.bySession[schedule.sessionKey] ?? 0) + 1;

      if (schedule.status === "pending" && schedule.triggerTime < earliestDue) {
        earliestDue = schedule.triggerTime;
      }
    }

    if (earliestDue !== Infinity) {
      stats.nextDue = new Date(earliestDue);
    }

    return stats;
  }
}

export function formatScheduleSummary(schedule: ScheduledRecall): string {
  const lines = [
    `🗓️ Schedule ${schedule.scheduleId}`,
    `   Query: "${schedule.query}"`,
    `   Trigger: ${new Date(schedule.triggerTime).toLocaleString()}`,
    `   Priority: ${schedule.priority}`,
    `   Status: ${schedule.status}`,
    `   Session: ${schedule.sessionKey}`,
  ];

  if (schedule.recurrence) {
    lines.push(`   Recurrence: ${schedule.recurrence.type}`);
    if (schedule.recurrence.maxOccurrences) {
      lines.push(
        `   Occurrences: ${schedule.recurrence.occurrencesCompleted ?? 0}/${schedule.recurrence.maxOccurrences}`
      );
    }
  }

  if (schedule.contextTags.length > 0) {
    lines.push(`   Tags: ${schedule.contextTags.join(", ")}`);
  }

  if (schedule.result) {
    lines.push(`   Result: ${schedule.result.memoryFound ? "✅ Memory found" : "❌ No memory"}`);
    if (schedule.result.summary) {
      lines.push(`   Summary: ${schedule.result.summary.substring(0, 100)}...`);
    }
    if (schedule.result.error) {
      lines.push(`   Error: ${schedule.result.error}`);
    }
  }

  return lines.join("\n");
}

export function formatSchedulerStats(stats: {
  totalSchedules: number;
  pending: number;
  completed: number;
  cancelled: number;
  failed: number;
  byPriority: Record<string, number>;
  bySession: Record<string, number>;
  nextDue?: Date;
}): string {
  const lines = [
    "📊 Memory Scheduler Statistics",
    "",
    `🗓️ Total Schedules: ${stats.totalSchedules}`,
    `⏳ Pending: ${stats.pending}`,
    `✅ Completed: ${stats.completed}`,
    `❌ Cancelled: ${stats.cancelled}`,
    `⚠️ Failed: ${stats.failed}`,
  ];

  if (stats.nextDue) {
    lines.push(``, `🕐 Next Due: ${stats.nextDue.toLocaleString()}`);
  }

  lines.push("", "📈 By Priority:");
  const priorityEmojis = { urgent: "🔥", high: "⚡", normal: "📌", low: "📝" };
  for (const [priority, count] of Object.entries(stats.byPriority)) {
    const emoji = priorityEmojis[priority as keyof typeof priorityEmojis] ?? "📌";
    lines.push(`  ${emoji} ${priority}: ${count}`);
  }

  if (Object.keys(stats.bySession).length > 0) {
    lines.push("", "📈 By Session:");
    for (const [session, count] of Object.entries(stats.bySession)) {
      lines.push(`  • ${session}: ${count}`);
    }
  }

  return lines.join("\n");
}
