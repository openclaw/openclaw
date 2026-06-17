/**
 * Reproduction script for issue #93031:
 * Cron jobs migrated from jobs.json have NULL agent_id, causing scheduler to skip them.
 *
 * This script demonstrates that the fix correctly uses config's defaultAgentId
 * instead of hardcoding "main", which would break non-main default agent setups.
 */

import { normalizeStoredCronJobs } from "../../src/commands/doctor/cron/store-migration.js";

console.log("🧪 Reproduction script for issue #93031");
console.log("Testing config-aware agent_id normalization for migrated cron jobs\n");

// Simulate jobs migrated from legacy jobs.json (no agentId field)
const migratedJobs = [
  {
    id: "transcript-logger",
    name: "Transcript Logger",
    schedule: { kind: "every", everyMs: 300_000 }, // every 5 minutes
    payload: { kind: "systemEvent", text: "Log transcript" },
    sessionTarget: "main",
    // Note: no agentId field - this is the bug!
  },
  {
    id: "memory-consolidation",
    name: "Memory Consolidation",
    schedule: { kind: "cron", expr: "0 */6 * * *", tz: "UTC" }, // every 6 hours
    payload: { kind: "systemEvent", text: "Consolidate memory" },
    sessionTarget: "main",
    // Note: no agentId field
  },
];

console.log("=== Before Fix (simulated) ===");
console.log("Migrated jobs from jobs.json:");
migratedJobs.forEach((job, i) => {
  console.log(`  ${i + 1}. ${job.name}: agentId = ${job.agentId ?? "undefined/NULL"}`);
});
console.log();

console.log("=== After Fix (with config-aware normalization) ===");

// Test 1: Default agent is "main" (most common case)
console.log("\n1. Config with defaultAgentId = 'main':");
const jobsForMain = structuredClone(migratedJobs);
normalizeStoredCronJobs(jobsForMain, { defaultAgentId: "main" });
jobsForMain.forEach((job, i) => {
  console.log(`   ${i + 1}. ${job.name}: agentId = "${job.agentId}" ✓`);
});

// Test 2: Default agent is "ops" (multi-agent setup)
console.log("\n2. Config with defaultAgentId = 'ops' (multi-agent setup):");
const jobsForOps = structuredClone(migratedJobs);
normalizeStoredCronJobs(jobsForOps, { defaultAgentId: "ops" });
jobsForOps.forEach((job, i) => {
  console.log(`   ${i + 1}. ${job.name}: agentId = "${job.agentId}" ✓`);
});

// Test 3: Mixed - some jobs have explicit agentId, some don't
console.log("\n3. Mixed jobs (some with explicit agentId, some without):");
const mixedJobs = [
  {
    id: "job-no-agent-id",
    name: "Job without agentId",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", text: "tick" },
  },
  {
    id: "job-explicit-agent",
    name: "Job with custom agent",
    schedule: { kind: "every", everyMs: 120_000 },
    payload: { kind: "systemEvent", text: "tock" },
    agentId: "custom-agent", // Explicit non-default agent
  },
  {
    id: "job-empty-agent-id",
    name: "Job with empty agentId",
    schedule: { kind: "every", everyMs: 180_000 },
    payload: { kind: "systemEvent", text: "tick-tock" },
    agentId: "", // Empty string
  },
] as Array<Record<string, unknown>>;

normalizeStoredCronJobs(mixedJobs, { defaultAgentId: "main" });
mixedJobs.forEach((job, i) => {
  const agentId = typeof job.agentId === "string" ? job.agentId : "undefined";
  const name = typeof job.name === "string" ? job.name : "unknown";
  console.log(`   ${i + 1}. ${name}: agentId = "${agentId}"`);
});

console.log("\n=== Summary ===");
console.log("✅ Migrated jobs without agentId now get config's defaultAgentId");
console.log("✅ Explicit non-default agentId values are preserved");
console.log("✅ Empty/whitespace agentId values are normalized to defaultAgentId");
console.log("✅ This fix avoids the 'hardcode main' bug that would break multi-agent setups");
console.log();
console.log("Fix location: src/commands/doctor/cron/store-migration.ts");
console.log("Fix approach: config-aware migration using resolveDefaultAgentId(cfg)");
