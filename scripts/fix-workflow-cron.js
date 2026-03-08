#!/usr/bin/env node
// Fix Workflow Cron Expression
// Changes cron expression from Friday-only to every 5 minutes

import fs from "node:fs";
import path from "node:path";

const jobsPath = path.join(process.env.HOME || "", ".openclaw/cron/jobs.json");

console.log("🔧 Fixing Workflow Cron Expression");
console.log("═══════════════════════════════════════════════════");
console.log(`📁 File: ${jobsPath}\n`);

if (!fs.existsSync(jobsPath)) {
  console.error(`❌ File not found: ${jobsPath}`);
  process.exit(1);
}

const content = fs.readFileSync(jobsPath, "utf-8");
const data = JSON.parse(content);

let changed = 0;

for (const job of data.jobs || []) {
  const oldExpr = job.schedule?.expr;

  if (oldExpr === "* * * * 5") {
    job.schedule.expr = "*/5 * * * *";
    job.updatedAtMs = Date.now();

    console.log(`✅ Updated: ${job.name}`);
    console.log(`   Old: ${oldExpr} (only on Fridays)`);
    console.log(`   New: ${job.schedule.expr} (every 5 minutes)`);
    console.log(`   Next Run: Will be recalculated on gateway restart\n`);

    changed++;
  } else if (oldExpr) {
    console.log(`⏭️  Skipped: ${job.name} (expression: ${oldExpr})\n`);
  }
}

if (changed === 0) {
  console.log("⚠️  No jobs with '* * * * 5' expression found.");
  process.exit(0);
}

// Backup old file
const backupPath = jobsPath + `.backup.${Date.now()}`;
fs.writeFileSync(backupPath, content, "utf-8");
console.log(`💾 Backup saved: ${backupPath}\n`);

// Write updated file
fs.writeFileSync(jobsPath, JSON.stringify(data, null, 2), "utf-8");

console.log("═══════════════════════════════════════════════════");
console.log("✅ Done! Restart gateway to apply changes:");
console.log("   openclaw gateway restart");
console.log("\nOr wait for next auto-reload.");
