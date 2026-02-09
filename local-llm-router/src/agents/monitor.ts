/**
 * Monitor agent — always-on background agent.
 * Handles email monitoring (IMAP IDLE), cron jobs, health checks, and notifications.
 * Uses local model (lightweight).
 */

import type { Task } from "../types.js";
import { BaseAgent, type AgentResult } from "./base-agent.js";

export class MonitorAgent extends BaseAgent {
  async execute(task: Task): Promise<AgentResult> {
    return this.runWithTracking(task, async () => {
      const { intent } = task.classification;

      switch (intent) {
        case "schedule_task":
          return this.scheduleTask(task);
        default:
          return this.handleMonitorTask(task);
      }
    });
  }

  private async scheduleTask(task: Task): Promise<string> {
    // TODO: Integrate with cron scheduler
    return `[Schedule] Would schedule: "${task.input}" (requires approval)`;
  }

  private async handleMonitorTask(task: Task): Promise<string> {
    // TODO: Generic monitoring task handler
    return `[Monitor] Would handle: "${task.input}"`;
  }

  // --- Background services (started separately, not via task queue) ---

  /**
   * Start IMAP IDLE monitoring. Runs continuously.
   */
  async startEmailMonitor(): Promise<void> {
    // TODO: Integrate with IMAP IDLE
    // On new email → classify → route to appropriate agent
    console.log(`[monitor] Email monitoring started`);
  }

  /**
   * Start cron scheduler. Runs continuously.
   */
  async startCronScheduler(): Promise<void> {
    // TODO: Load cron jobs from config, execute on schedule
    console.log(`[monitor] Cron scheduler started`);
  }

  /**
   * Start health checks. Runs periodically.
   */
  async startHealthChecks(): Promise<void> {
    // TODO: Check deployed app health, notify on issues
    console.log(`[monitor] Health checks started`);
  }
}
