#!/usr/bin/env bun

import { $ } from "bun";

// Configuration
const ALERT_CHANNEL = "telegram";
const TARGET_USER = process.env.OPENCLAW_WATCHDOG_TARGET || "512037841"; // Yee (@Zack0ll0)
const CHECK_WINDOW_MINUTES = Number(process.env.WATCHDOG_WINDOW) || 60; // Look for errors in the last hour

interface CronJob {
  id: string;
  name: string;
  state: {
    lastRunAtMs?: number;
    lastStatus?: "ok" | "error";
    lastError?: string;
  };
}

interface CronListOutput {
  jobs: CronJob[];
}

async function main() {
  try {
    // 1. Get Cron Status (JSON)
    const { stdout } = await $`openclaw cron list --json`.quiet();
    const data = JSON.parse(stdout.toString()) as CronListOutput;

    const now = Date.now();
    const errors: CronJob[] = [];

    // 2. Filter for recent errors
    for (const job of data.jobs) {
      if (job.state.lastStatus === "error" && job.state.lastRunAtMs) {
        const diffMinutes = (now - job.state.lastRunAtMs) / 1000 / 60;
        if (diffMinutes <= CHECK_WINDOW_MINUTES) {
          errors.push(job);
        }
      }
    }

    // 3. Report
    if (errors.length > 0) {
      console.log(`[Watchdog] Found ${errors.length} failed jobs.`);

      const errorDetails = errors
        .map((j) => `• *${j.name}*\n  Error: ${j.state.lastError?.slice(0, 100)}...`)
        .join("\n\n");

      const alertMessage = `🚨 *SYSTEM ALERT: Watchdog*\n\nFound ${errors.length} failed cron jobs in the last ${CHECK_WINDOW_MINUTES / 60} hours:\n\n${errorDetails}\n\n_This is an automated message from the Dumb Watchdog script._`;

      await $`openclaw message send --channel ${ALERT_CHANNEL} --target ${TARGET_USER} --message ${alertMessage}`;
      console.log("[Watchdog] Alert sent.");
    } else {
      console.log("[Watchdog] No recent errors found.");
    }
  } catch (error) {
    console.error("[Watchdog] Failed to run check:", error);
    process.exit(1);
  }
}

main();
