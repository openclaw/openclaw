#!/usr/bin/env node
/**
 * Manual Workflow Trigger Script
 *
 * Usage:
 *   node scripts/trigger-workflow-manual.js <job-id>
 *
 * This script manually triggers a workflow cron job for testing,
 * bypassing the cron schedule.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";

function getFirstJobId() {
  const jobsPath = "~/.openclaw/cron/jobs.json".replace("~", process.env.HOME || "");
  if (!fs.existsSync(jobsPath)) {
    console.error("❌ Cron jobs file not found:", jobsPath);
    process.exit(1);
  }

  const content = fs.readFileSync(jobsPath, "utf-8");
  const data = JSON.parse(content);
  const jobs = data.jobs || [];

  if (jobs.length === 0) {
    console.error("❌ No cron jobs found");
    process.exit(1);
  }

  return jobs[0].id;
}

function main() {
  const args = process.argv.slice(2);
  let jobId = args[0];

  if (!jobId) {
    console.log("⚠️  No job ID provided, using first available job...");
    jobId = getFirstJobId();
    console.log(`   Using job ID: ${jobId}`);
  }

  console.log("🚀 Manual Workflow Trigger");
  console.log("═══════════════════════════════════════════════════");
  console.log(`📋 Job ID: ${jobId}`);
  console.log(`📡 Triggering via openclaw CLI...\n`);

  try {
    // Use openclaw CLI to manually run the cron job
    const cmd = `openclaw cron run "${jobId}" --force`;
    console.log(`📝 Executing: ${cmd}`);

    const output = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000, // 2 minute timeout
    });

    console.log("\n✅ Job triggered successfully!");
    console.log("\n📊 Output:");
    console.log("─────────────────────────────────────────────────────");
    console.log(output);
    console.log("─────────────────────────────────────────────────────");

    console.log("\n💡 Check gateway logs for detailed workflow execution:");
    console.log(`   tail -f /tmp/openclaw/openclaw-${new Date().toISOString().split("T")[0]}.log`);
    console.log("\n   Or filter for workflow logs:");
    console.log(`   grep -i "workflow\\|cron:" /tmp/openclaw/openclaw-*.log | tail -100`);
  } catch (err) {
    console.error("\n❌ Failed to trigger job:");
    console.error("─────────────────────────────────────────────────────");
    console.error(err.stdout || err.stderr || err.message);
    console.error("─────────────────────────────────────────────────────");

    console.log("\n💡 Alternative: Use the gateway WebSocket directly:");
    console.log(`   openclaw gateway call cron.run '{ "jobId": "${jobId}" }'`);

    process.exit(1);
  }
}

main();
