#!/usr/bin/env tsx
/**
 * Script để debug workflow sessions sau khi RUN NOW cronjob
 *
 * Usage:
 *   pnpm tsx scripts/debug-workflow-sessions.ts
 *   pnpm tsx scripts/debug-workflow-sessions.ts --agent main
 *   pnpm tsx scripts/debug-workflow-sessions.ts --job-id <job-id>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || process.env.USERPROFILE || "";
const OPENCLAW_DIR = path.join(HOME, ".openclaw");

interface SessionEntry {
  sessionId: string;
  label?: string;
  createdAt?: number;
  updatedAt?: number;
  model?: string;
  modelProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  skillsSnapshot?: unknown;
}

type SessionStore = Record<string, SessionEntry>;

function findSessionFiles(agentId: string): string[] {
  const sessionsDir = path.join(OPENCLAW_DIR, "agents", agentId, "sessions");

  if (!fs.existsSync(sessionsDir)) {
    console.log(`❌ Sessions directory not found: ${sessionsDir}`);
    return [];
  }

  const files = fs.readdirSync(sessionsDir);
  return files
    .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
    .map((f) => path.join(sessionsDir, f))
    .toSorted((a, b) => {
      const statA = fs.statSync(a);
      const statB = fs.statSync(b);
      return statB.mtimeMs - statA.mtimeMs;
    });
}

function readSessionStore(filePath: string): SessionStore | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as SessionStore;
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return null;
  }
}

function isCronSession(sessionKey: string): boolean {
  return sessionKey.includes("cron:");
}

function isWorkflowSession(sessionKey: string): boolean {
  return (
    sessionKey.includes("workflow:") ||
    (sessionKey.includes("cron:") && sessionKey.includes(":step"))
  );
}

function formatTimestamp(ts?: number): string {
  if (!ts) {
    return "N/A";
  }
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function formatBytes(tokens?: number): string {
  if (!tokens) {
    return "0";
  }
  return tokens.toLocaleString();
}

function findCronSessions(store: SessionStore): Array<{ key: string; entry: SessionEntry }> {
  return Object.entries(store)
    .filter(([key]) => isCronSession(key))
    .map(([key, entry]) => ({ key, entry }))
    .toSorted((a, b) => {
      const aTime = a.entry.updatedAt || a.entry.createdAt || 0;
      const bTime = b.entry.updatedAt || b.entry.createdAt || 0;
      return bTime - aTime;
    });
}

function main() {
  const args = process.argv.slice(2);
  const agentIndex = args.indexOf("--agent");
  const agentId = agentIndex >= 0 ? args[agentIndex + 1] : "main";

  const jobIdIndex = args.indexOf("--job-id");
  const jobIdFilter = jobIdIndex >= 0 ? args[jobIdIndex + 1] : null;

  console.log("🔍 OpenClaw Workflow Session Debugger");
  console.log("=====================================\n");
  console.log(`OpenClaw Dir: ${OPENCLAW_DIR}`);
  console.log(`Agent: ${agentId}`);
  if (jobIdFilter) {
    console.log(`Filter by Job ID: ${jobIdFilter}`);
  }
  console.log();

  // Find session files
  const sessionFiles = findSessionFiles(agentId);

  if (sessionFiles.length === 0) {
    console.log("❌ No session files found");
    return;
  }

  console.log(`📁 Found ${sessionFiles.length} session file(s):\n`);

  let totalCronSessions = 0;
  let totalWorkflowSessions = 0;

  for (const filePath of sessionFiles) {
    const fileName = path.basename(filePath);
    console.log(`📄 ${fileName}`);

    const store = readSessionStore(filePath);
    if (!store) {
      continue;
    }

    const cronSessions = findCronSessions(store);

    if (cronSessions.length === 0) {
      console.log("   └─ No cron sessions found\n");
      continue;
    }

    console.log(`   └─ ${cronSessions.length} cron session(s):\n`);

    for (const { key, entry } of cronSessions) {
      // Filter by job ID if specified
      if (jobIdFilter && !key.includes(jobIdFilter)) {
        continue;
      }

      totalCronSessions++;

      const isWorkflow = isWorkflowSession(key);
      if (isWorkflow) {
        totalWorkflowSessions++;
      }

      const icon = isWorkflow ? "⚙️" : "⏰";
      console.log(`   ${icon} Session Key: ${key}`);
      console.log(`      Label: ${entry.label || "N/A"}`);
      console.log(`      Session ID: ${entry.sessionId}`);
      console.log(`      Created: ${formatTimestamp(entry.createdAt)}`);
      console.log(`      Updated: ${formatTimestamp(entry.updatedAt)}`);
      console.log(`      Model: ${entry.modelProvider || "N/A"}/${entry.model || "N/A"}`);
      console.log(
        `      Tokens: ${formatBytes(entry.totalTokens)} total (${formatBytes(entry.inputTokens)} in, ${formatBytes(entry.outputTokens)} out)`,
      );

      if (entry.skillsSnapshot) {
        const snapshot = entry.skillsSnapshot as Record<string, unknown>;
        if (typeof snapshot === "object" && snapshot !== null) {
          console.log(`      Skills: ${Object.keys(snapshot).length} file(s)`);
        }
      }

      console.log();
    }
  }

  console.log("\n📊 Summary:");
  console.log(`   Total Cron Sessions: ${totalCronSessions}`);
  console.log(`   Total Workflow Sessions: ${totalWorkflowSessions}`);

  if (totalCronSessions === 0) {
    console.log("\n⚠️  No cron sessions found!");
    console.log("   Possible reasons:");
    console.log("   1. Cron job has not been executed yet");
    console.log("   2. Sessions were cleaned up by session reaper");
    console.log("   3. Wrong agent ID (try --agent <agent-id>)");
    console.log("   4. Sessions stored in different location");
    console.log("\n💡 Try running the cron job first:");
    console.log("   openclaw cron run <job-id>");
    console.log("   openclaw cron runs --job-id <job-id>");
  }

  if (totalWorkflowSessions > 0) {
    console.log("\n✅ Workflow sessions found!");
    console.log("   To view session transcripts:");
    console.log("   ls -lt ~/.openclaw/agents/<agent-id>/transcripts/");
  }
}

main();
