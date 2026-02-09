/**
 * Monitor agent — always-on background agent.
 * Handles email monitoring (IMAP IDLE), cron jobs, health checks, and notifications.
 * Uses local model (lightweight).
 */

import type { Task, ImapConfig } from "../types.js";
import { BaseAgent, type AgentResult } from "./base-agent.js";
import { startEmailMonitor, type EmailMessage } from "../tools/email.js";
import { runDailyAnalysis } from "../errors/analysis.js";
import { runKnowledgeScout } from "../scout/knowledge-scout.js";
import { ErrorJournal } from "../errors/journal.js";
import type { TokenTracker } from "../monitoring/token-tracker.js";

export interface CronJob {
  id: string;
  schedule: string; // "daily", "hourly", or cron-like "0 9 * * *"
  action: string;
  lastRun?: string;
}

export class MonitorAgent extends BaseAgent {
  private emailStopFn: (() => Promise<void>) | null = null;
  private cronIntervals: NodeJS.Timeout[] = [];
  private healthInterval: NodeJS.Timeout | null = null;

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
    const parsePrompt = [
      "Parse this scheduling request. Return a JSON object with:",
      '{ "action": "what to do", "schedule": "when to do it (daily/hourly/weekly)", "time": "specific time if mentioned" }',
      "",
      `Request: ${task.input}`,
    ].join("\n");

    const parsed = await this.callModel(task, parsePrompt, { maxTokens: 200 });

    await this.audit({
      action: "schedule_task",
      tool: "cron",
      output: parsed.slice(0, 200),
    });

    return `Schedule request noted (requires approval):\n\n${parsed}\n\nOnce approved, this will be added to the cron scheduler.`;
  }

  private async handleMonitorTask(task: Task): Promise<string> {
    return this.callModel(task, task.input);
  }

  // --- Background services (started separately, not via task queue) ---

  /**
   * Start IMAP IDLE monitoring. Runs continuously.
   */
  async startEmailMonitoring(
    imapConfig: ImapConfig,
    onNewEmail: (email: EmailMessage) => void | Promise<void>,
  ): Promise<void> {
    try {
      this.emailStopFn = await startEmailMonitor(imapConfig, {
        onNewEmail: async (email) => {
          console.log(`[monitor] New email from ${email.from}: ${email.subject}`);
          await onNewEmail(email);
        },
        onError: (error) => {
          console.error("[monitor] Email monitor error:", error.message);
        },
      });
      console.log("[monitor] Email monitoring started");
    } catch (err) {
      console.error("[monitor] Failed to start email monitoring:", err);
    }
  }

  /**
   * Start the daily error analysis cron job.
   */
  startDailyAnalysis(errorJournal: ErrorJournal): void {
    // Run daily at midnight
    const interval = setInterval(async () => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        console.log("[monitor] Running daily error analysis...");
        try {
          const report = await runDailyAnalysis({
            projectRoot: this.deps.projectRoot,
            errorJournal,
            analysisModel: this.resolveModel({
              route: { model: "cloud" },
            } as Task),
          });
          console.log(
            `[monitor] Analysis complete: ${report.errorCount} errors, ${report.proposals.length} proposals`,
          );
        } catch (err) {
          console.error("[monitor] Daily analysis failed:", err);
        }
      }
    }, 60_000); // Check every minute

    this.cronIntervals.push(interval);
    console.log("[monitor] Daily analysis scheduler started");
  }

  /**
   * Start the weekly knowledge scout.
   * Searches Reddit, HN, etc. for techniques to improve skills/config.
   */
  startKnowledgeScout(): void {
    // Run weekly — check every hour, execute on Sundays at 06:00
    const interval = setInterval(async () => {
      const now = new Date();
      if (now.getDay() === 0 && now.getHours() === 6 && now.getMinutes() === 0) {
        console.log("[monitor] Running weekly knowledge scout...");
        try {
          const report = await runKnowledgeScout({
            projectRoot: this.deps.projectRoot,
            analysisModel: this.resolveModel({
              route: { model: "cloud" },
            } as Task),
          });
          console.log(
            `[monitor] Scout complete: ${report.insights.length} insights, ${report.proposals.length} proposals`,
          );
        } catch (err) {
          console.error("[monitor] Knowledge scout failed:", err);
        }
      }
    }, 60_000);

    this.cronIntervals.push(interval);
    console.log("[monitor] Knowledge scout scheduler started (weekly, Sundays 06:00)");
  }

  /**
   * Start health checks. Pings configured endpoints periodically.
   */
  startHealthChecks(endpoints: Array<{ name: string; url: string }>): void {
    if (endpoints.length === 0) {
      console.log("[monitor] No health check endpoints configured");
      return;
    }

    this.healthInterval = setInterval(async () => {
      for (const ep of endpoints) {
        try {
          const start = Date.now();
          const res = await fetch(ep.url, { signal: AbortSignal.timeout(10_000) });
          const durationMs = Date.now() - start;

          if (!res.ok) {
            console.warn(`[monitor] Health check FAILED: ${ep.name} (${res.status}) ${durationMs}ms`);
            await this.audit({
              action: "health_check_fail",
              tool: "healthcheck",
              input: { endpoint: ep.name, url: ep.url },
              error: `HTTP ${res.status}`,
              durationMs,
            });
          }
        } catch (err) {
          console.warn(`[monitor] Health check ERROR: ${ep.name}: ${err}`);
        }
      }
    }, 5 * 60_000); // Every 5 minutes

    console.log(`[monitor] Health checks started for ${endpoints.length} endpoints`);
  }

  /**
   * Start periodic budget checks. Runs every 30 minutes.
   * Calls the alert callback when budget thresholds are hit.
   */
  startBudgetMonitor(
    tokenTracker: TokenTracker,
    onAlert: (message: string) => void | Promise<void>,
  ): void {
    const interval = setInterval(async () => {
      try {
        const alerts = await tokenTracker.checkBudget();
        for (const alert of alerts) {
          if (alert.level === "warning" || alert.level === "critical") {
            await onAlert(tokenTracker.formatAlertsForTelegram([alert]));
          }
        }
      } catch (err) {
        console.error("[monitor] Budget check failed:", err);
      }
    }, 30 * 60_000); // Every 30 minutes

    this.cronIntervals.push(interval);
    console.log("[monitor] Budget monitor started (every 30 min)");
  }

  /**
   * Start daily cost summary. Sends a report at 23:00 each night.
   */
  startDailyCostSummary(
    tokenTracker: TokenTracker,
    onSummary: (message: string) => void | Promise<void>,
  ): void {
    const interval = setInterval(async () => {
      const now = new Date();
      if (now.getHours() === 23 && now.getMinutes() === 0) {
        try {
          const today = await tokenTracker.todaySummary();
          const msg = tokenTracker.formatForTelegram(today);
          await onSummary(msg);
        } catch (err) {
          console.error("[monitor] Daily cost summary failed:", err);
        }
      }
    }, 60_000);

    this.cronIntervals.push(interval);
    console.log("[monitor] Daily cost summary started (23:00)");
  }

  /**
   * Stop all background services.
   */
  async stopAll(): Promise<void> {
    if (this.emailStopFn) {
      await this.emailStopFn();
      this.emailStopFn = null;
    }
    for (const interval of this.cronIntervals) {
      clearInterval(interval);
    }
    this.cronIntervals = [];
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    console.log("[monitor] All background services stopped");
  }
}
