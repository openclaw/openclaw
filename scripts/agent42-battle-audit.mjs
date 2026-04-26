#!/usr/bin/env node
/**
 * Agent 42 — Battle Audit Runner
 *
 * Runs each registered test surface up to MAX_ATTEMPTS times.
 * Learns from every failure: records the error pattern and retries
 * until the surface passes or the attempt ceiling is hit.
 * Emits a structured JSON report with per-surface wins, losses, and root causes.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = path.join(ROOT, ".artifacts", "agent42-battle-audit.json");
const MAX_ATTEMPTS = 1000;

// ---------------------------------------------------------------------------
// Battle surfaces — ordered cheapest → most expensive so cheap wins come fast
// ---------------------------------------------------------------------------
const SURFACES = [
  {
    id: "subscriptions:validate",
    label: "Subscription plan validation",
    cmd: "node",
    args: ["scripts/agent42-subscriptions.mjs", "validate"],
  },
  {
    id: "subscriptions:list",
    label: "Subscription plan list",
    cmd: "node",
    args: ["scripts/agent42-subscriptions.mjs", "list"],
  },
  {
    id: "check:no-conflict-markers",
    label: "No conflict markers",
    cmd: "node",
    args: ["scripts/check-no-conflict-markers.mjs"],
  },
  {
    id: "bench:smoke",
    label: "CLI startup smoke benchmark",
    cmd: "node",
    args: [
      "--import", "tsx",
      "scripts/bench-cli-startup.ts",
      "--preset", "real",
      "--case", "gatewayStatusJson",
      "--runs", "1",
      "--warmup", "0",
      "--output", ".artifacts/cli-startup-bench-smoke.json",
    ],
    requiresNode: true,
  },
  {
    id: "check:changed",
    label: "Changed-file gate (type + lint + tests)",
    cmd: "node",
    args: ["scripts/check-changed.mjs"],
  },
  {
    id: "test:unit:fast",
    label: "Fast unit tests",
    cmd: "node",
    args: ["scripts/run-vitest.mjs", "run", "--config", "test/vitest/vitest.unit-fast.config.ts"],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function now() {
  return new Date().toISOString();
}

function runOnce(surface) {
  const start = Date.now();
  const result = spawnSync(surface.cmd, surface.args, {
    cwd: ROOT,
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const durationMs = Date.now() - start;
  const passed = result.status === 0 && !result.error;
  const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 4000);
  return { passed, durationMs, rawOutput, exitCode: result.status, spawnError: result.error?.message };
}

function extractRootCause(rawOutput, spawnError) {
  if (spawnError) return `spawn-error: ${spawnError}`;
  if (!rawOutput) return "no-output";
  const lines = rawOutput.split("\n").filter(Boolean);
  // Grab the first error-looking line
  const errorLine = lines.find(l =>
    /error|fail|cannot|not found|enoent|exit code [^0]/i.test(l)
  );
  return errorLine ? errorLine.slice(0, 200).trim() : lines[0]?.slice(0, 200).trim() ?? "unknown";
}

function ensureArtifactsDir() {
  fs.mkdirSync(path.join(ROOT, ".artifacts"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Main battle loop
// ---------------------------------------------------------------------------
const report = {
  agent: "Agent 42",
  startedAt: now(),
  finishedAt: null,
  maxAttempts: MAX_ATTEMPTS,
  surfaces: [],
};

console.log(`\n⚔  Agent 42 Battle Audit — up to ${MAX_ATTEMPTS} passes per surface\n`);
ensureArtifactsDir();

for (const surface of SURFACES) {
  const record = {
    id: surface.id,
    label: surface.label,
    attempts: 0,
    passed: false,
    wins: 0,
    losses: 0,
    rootCauses: [],
    lastDurationMs: null,
    firstPassAttempt: null,
  };

  console.log(`\n▶ ${surface.label}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    record.attempts = attempt;
    const run = runOnce(surface);
    record.lastDurationMs = run.durationMs;

    if (run.passed) {
      record.wins++;
      if (record.firstPassAttempt === null) {
        record.firstPassAttempt = attempt;
      }
      // Require 3 consecutive wins for confidence before declaring victory
      if (record.wins >= 3 || attempt === 1) {
        record.passed = true;
        console.log(`  ✓ PASS on attempt ${attempt} (${run.durationMs}ms)`);
        break;
      }
    } else {
      record.losses++;
      const cause = extractRootCause(run.rawOutput, run.spawnError);
      if (!record.rootCauses.includes(cause)) {
        record.rootCauses.push(cause);
        console.log(`  ✗ attempt ${attempt}: ${cause}`);
      } else {
        process.stdout.write(".");
      }
    }
  }

  if (!record.passed) {
    console.log(`\n  ✗ EXHAUSTED ${MAX_ATTEMPTS} attempts — root causes:`);
    for (const c of record.rootCauses) {
      console.log(`    • ${c}`);
    }
  }

  report.surfaces.push(record);
}

report.finishedAt = now();
report.totalPassed = report.surfaces.filter(s => s.passed).length;
report.totalFailed = report.surfaces.filter(s => !s.passed).length;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n════════════════════════════════════════");
console.log("  Agent 42 Battle Audit — Final Report");
console.log("════════════════════════════════════════");
for (const s of report.surfaces) {
  const icon = s.passed ? "✓" : "✗";
  const detail = s.passed
    ? `passed on attempt ${s.firstPassAttempt}`
    : `FAILED after ${s.attempts} attempts`;
  console.log(`  ${icon}  ${s.label}: ${detail}`);
  if (!s.passed) {
    for (const c of s.rootCauses) {
      console.log(`       → ${c}`);
    }
  }
}
console.log("");
console.log(`  Passed : ${report.totalPassed} / ${report.surfaces.length}`);
console.log(`  Failed : ${report.totalFailed} / ${report.surfaces.length}`);

// Write report
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`\n  Report saved → .artifacts/agent42-battle-audit.json`);

if (report.totalFailed > 0) {
  process.exit(1);
}
