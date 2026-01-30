/**
 * Moltbot Secure - Task Scheduler
 *
 * Simple cron-like scheduler for recurring tasks.
 * Stores jobs in memory or optionally persists to file.
 */

import { CronJob } from "cron";
import type { SecureConfig } from "./config.js";
import type { AuditLogger } from "./audit.js";
import type { AgentCore } from "./agent.js";
import type { Bot } from "grammy";
import { sendToUser } from "./telegram.js";

export type ScheduledTask = {
  id: string;
  name: string;
  schedule: string; // Cron expression
  prompt: string; // What to ask the AI
  enabled: boolean;
  lastRun?: Date;
  lastStatus?: "ok" | "error";
  lastError?: string;
};

export type Scheduler = {
  addTask: (task: Omit<ScheduledTask, "id">) => string;
  removeTask: (id: string) => boolean;
  enableTask: (id: string, enabled: boolean) => boolean;
  listTasks: () => ScheduledTask[];
  runTask: (id: string) => Promise<void>;
  start: () => void;
  stop: () => void;
};

export type SchedulerDeps = {
  config: SecureConfig;
  audit: AuditLogger;
  agent: AgentCore;
  telegramBot: Bot;
};

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { config, audit, agent, telegramBot } = deps;
  const tasks = new Map<string, ScheduledTask>();
  const cronJobs = new Map<string, CronJob<null, unknown>>();

  async function executeTask(task: ScheduledTask): Promise<void> {
    const startTime = Date.now();

    try {
      // Run the AI with the task prompt
      const response = await agent.chat([
        { role: "user", content: task.prompt },
      ]);

      // Notify users
      const message = `**Scheduled Task: ${task.name}**\n\n${response.text}`;
      for (const userId of config.telegram.allowedUsers) {
        await sendToUser(telegramBot, userId, message);
      }

      task.lastRun = new Date();
      task.lastStatus = "ok";
      task.lastError = undefined;

      audit.cron({
        jobId: task.id,
        jobName: task.name,
        status: "ok",
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      task.lastRun = new Date();
      task.lastStatus = "error";
      task.lastError = errorMsg;

      audit.cron({
        jobId: task.id,
        jobName: task.name,
        status: "error",
        error: errorMsg,
        durationMs: Date.now() - startTime,
      });

      // Notify about error
      const message = `**Scheduled Task Failed: ${task.name}**\n\nError: ${errorMsg}`;
      for (const userId of config.telegram.allowedUsers) {
        await sendToUser(telegramBot, userId, message);
      }
    }
  }

  function scheduleTask(task: ScheduledTask): void {
    // Remove existing job if any
    const existing = cronJobs.get(task.id);
    if (existing) {
      existing.stop();
      cronJobs.delete(task.id);
    }

    if (!task.enabled || !config.scheduler.enabled) {
      return;
    }

    try {
      const job = new CronJob(
        task.schedule,
        () => {
          void executeTask(task);
        },
        null,
        true, // Start immediately
        undefined, // Default timezone
        undefined,
        false // Don't run on init
      );
      cronJobs.set(task.id, job);
    } catch (err) {
      console.error(`[scheduler] Failed to schedule task ${task.id}:`, err);
    }
  }

  return {
    addTask(taskInput: Omit<ScheduledTask, "id">): string {
      const id = generateId();
      const task: ScheduledTask = { ...taskInput, id };
      tasks.set(id, task);
      scheduleTask(task);
      return id;
    },

    removeTask(id: string): boolean {
      const task = tasks.get(id);
      if (!task) return false;

      const job = cronJobs.get(id);
      if (job) {
        job.stop();
        cronJobs.delete(id);
      }

      tasks.delete(id);
      return true;
    },

    enableTask(id: string, enabled: boolean): boolean {
      const task = tasks.get(id);
      if (!task) return false;

      task.enabled = enabled;
      scheduleTask(task);
      return true;
    },

    listTasks(): ScheduledTask[] {
      return Array.from(tasks.values());
    },

    async runTask(id: string): Promise<void> {
      const task = tasks.get(id);
      if (!task) {
        throw new Error(`Task not found: ${id}`);
      }
      await executeTask(task);
    },

    start(): void {
      if (!config.scheduler.enabled) {
        console.log("[scheduler] Scheduler is disabled");
        return;
      }

      console.log("[scheduler] Starting scheduler...");
      for (const task of tasks.values()) {
        scheduleTask(task);
      }
    },

    stop(): void {
      console.log("[scheduler] Stopping scheduler...");
      for (const job of cronJobs.values()) {
        job.stop();
      }
      cronJobs.clear();
    },
  };
}

/**
 * Parse schedule from human-readable format
 */
export function parseSchedule(input: string): string | null {
  const lower = input.toLowerCase().trim();

  // Common patterns
  const patterns: Record<string, string> = {
    "every minute": "* * * * *",
    "every 5 minutes": "*/5 * * * *",
    "every 15 minutes": "*/15 * * * *",
    "every 30 minutes": "*/30 * * * *",
    "every hour": "0 * * * *",
    hourly: "0 * * * *",
    "every day": "0 9 * * *",
    daily: "0 9 * * *",
    "every morning": "0 9 * * *",
    "every evening": "0 18 * * *",
    "every week": "0 9 * * 1",
    weekly: "0 9 * * 1",
    "every monday": "0 9 * * 1",
    "every tuesday": "0 9 * * 2",
    "every wednesday": "0 9 * * 3",
    "every thursday": "0 9 * * 4",
    "every friday": "0 9 * * 5",
    "every saturday": "0 9 * * 6",
    "every sunday": "0 9 * * 0",
  };

  if (patterns[lower]) {
    return patterns[lower];
  }

  // Check if it's already a valid cron expression (5 or 6 fields)
  const parts = input.trim().split(/\s+/);
  if (parts.length >= 5 && parts.length <= 6) {
    return input.trim();
  }

  return null;
}

/**
 * Format next run time
 */
export function formatNextRun(cronExpression: string): string {
  try {
    const job = new CronJob(cronExpression, () => {});
    const nextDate = job.nextDate();
    return nextDate.toLocaleString();
  } catch {
    return "Invalid schedule";
  }
}

/**
 * Built-in task templates
 */
export const taskTemplates = {
  morningBriefing: {
    name: "Morning Briefing",
    schedule: "0 9 * * *", // 9 AM daily
    prompt: "Give me a brief morning update. Include: current date, a motivational quote, and remind me to check my priorities for the day.",
  },
  weeklyReview: {
    name: "Weekly Review",
    schedule: "0 17 * * 5", // 5 PM on Fridays
    prompt: "It's Friday. Help me reflect on the week. What should I consider for my weekly review?",
  },
  healthReminder: {
    name: "Health Reminder",
    schedule: "0 */2 * * *", // Every 2 hours
    prompt: "Give me a brief health reminder (stretch, drink water, take a break). Keep it under 2 sentences.",
  },
};
