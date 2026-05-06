import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CuratorRunResult } from "./run.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RunLogEntry {
  runId: string;
  timestamp: string;
  dryRun: boolean;
  snapshotPath: string | null;
  transitions: Array<{
    name: string;
    action: string;
    newState: string;
    daysSinceUsed: number;
  }>;
  mutations: Array<{
    name: string;
    action: string;
    oldState: string;
    newState: string;
  }>;
  error?: string;
}

// ── Path helpers ────────────────────────────────────────────────────────────

function runLogDir(): string {
  return path.join(os.homedir(), ".openclaw", "logs", "curator");
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── Log writer ──────────────────────────────────────────────────────────────

/**
 * Write a machine-readable run.json for a curator run.
 * Returns the run directory path.
 */
export async function writeRunLog(result: CuratorRunResult): Promise<string> {
  const id = runId();
  const dir = path.join(runLogDir(), id);
  await fs.mkdir(dir, { recursive: true });

  const entry: RunLogEntry = {
    runId: id,
    timestamp: result.timestamp,
    dryRun: result.dryRun,
    snapshotPath: result.snapshotPath,
    transitions: result.transitions,
    mutations: result.mutations,
    error: result.error,
  };

  await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(entry, null, 2), "utf-8");

  // Write human-readable REPORT.md
  await writeReport(dir, entry);

  return dir;
}

// ── Report writer ───────────────────────────────────────────────────────────

async function writeReport(dir: string, entry: RunLogEntry): Promise<void> {
  const lines: string[] = [];

  lines.push("# Curator Run Report");
  lines.push("");
  lines.push(`**Run ID:** ${entry.runId}`);
  lines.push(`**Timestamp:** ${entry.timestamp}`);
  lines.push(`**Mode:** ${entry.dryRun ? "DRY RUN (no mutations)" : "LIVE"}`);
  lines.push("");

  if (entry.error) {
    lines.push(`## ⚠️ Info`);
    lines.push("");
    lines.push(entry.error);
    lines.push("");
  }

  if (entry.snapshotPath) {
    lines.push(`## 📦 Snapshot`);
    lines.push("");
    lines.push(`Snapshot saved to: \`${entry.snapshotPath}\``);
    lines.push("");
  }

  if (entry.transitions.length > 0) {
    lines.push(`## 🔍 Transitions (${entry.transitions.length})`);
    lines.push("");
    lines.push("| Skill | Action | New State | Days Unused |");
    lines.push("|-------|--------|-----------|-------------|");
    for (const t of entry.transitions) {
      lines.push(`| ${t.name} | ${t.action} | ${t.newState} | ${t.daysSinceUsed.toFixed(0)} |`);
    }
    lines.push("");
  }

  if (entry.mutations.length > 0) {
    const marker = entry.dryRun ? " (would apply)" : "";
    lines.push(`## ✏️ Mutations${marker} (${entry.mutations.length})`);
    lines.push("");
    lines.push("| Skill | Action | Old State | New State |");
    lines.push("|-------|--------|-----------|-----------|");
    for (const m of entry.mutations) {
      lines.push(`| ${m.name} | ${m.action} | ${m.oldState} | ${m.newState} |`);
    }
    lines.push("");
  }

  if (entry.transitions.length === 0 && !entry.error) {
    lines.push("## ✅ No transitions needed");
    lines.push("");
    lines.push("All skills are up to date. No actions required.");
    lines.push("");
  }

  await fs.writeFile(path.join(dir, "REPORT.md"), lines.join("\n"), "utf-8");
}
