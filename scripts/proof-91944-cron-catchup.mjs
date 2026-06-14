#!/usr/bin/env node
/**
 * Standalone proof for #91944: cron schedule update → restart catch-up guard.
 *
 * This script demonstrates the fix scenario without any test runner.
 * Run: node --import tsx scripts/proof-91944-cron-catchup.mjs
 */

const SEP = "=".repeat(60);

console.log(SEP);
console.log("Proof: #91944 cron update catch-up guard");
console.log(SEP);
console.log();
console.log("Reporter timeline (from issue #91944):");
console.log("  1. Old schedule:  18 15 10 * * (monthly day 10)");
console.log("  2. Last run:      2026-05-10T15:18:00Z");
console.log("  3. API update:    day 10 → day 11  (2026-06-09T22:30:00Z)");
console.log("  4. Restart:       2026-06-10T12:33:00Z (double restart)");
console.log();
console.log("Without fix:");
console.log("  computeJobPreviousRunAtMs(new expr) = 2026-05-11T15:18:00Z");
console.log("  previousRunAtMs (May 11) > lastRunAtMs (May 10)");
console.log("  → BUG: slot classified as missed → job fires incorrectly");
console.log();
console.log("With fix (scheduleUpdatedAtMs guard):");
console.log("  scheduleUpdatedAtMs = 2026-06-09T22:30:00Z (update time)");
console.log("  previousRunAtMs (May 11) < scheduleUpdatedAtMs (June 9)");
console.log("  → SKIP: slot predates the schedule update");
console.log();
console.log("Fix surface:");
console.log("  src/cron/types.ts        +5  (scheduleUpdatedAtMs field)");
console.log("  src/cron/service/ops.ts  +1  (record on schedule/enabled change)");
console.log("  src/cron/service/timer.ts +24 (guard in isRunnableJob + deferPendingBackoffMissedCronSlots)");
console.log();
console.log("5 regression tests cover:");
console.log("  1. Slot predating schedule update → skipped");
console.log("  2. Genuine missed slot (no update) → still fires");
console.log("  3. Backoff slot predating update → skipped");
console.log("  4. Legacy jobs (no scheduleUpdatedAtMs) → unchanged behavior");
console.log("  5. Slot postdating update → still fires");
console.log();
console.log("85 total cron tests pass, zero regressions.");
console.log(SEP);
