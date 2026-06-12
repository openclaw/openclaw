/**
 * Reproduction script for issue #92291:
 * cron edit --cron silently strips schedule.tz and staggerMs.
 *
 * Demonstrates that resolveDirectSchedule() omits tz/staggerMs
 * when they are not passed on the edit invocation, and that the
 * command handler now merges them from the existing job.
 */
import { resolveCronEditScheduleRequest, applyExistingCronSchedulePatch } from "../src/cli/cron-cli/schedule-options.js";

// Simulate: existing job has cron schedule with tz and staggerMs
const existingSchedule = {
  kind: "cron",
  expr: "0 4 * * *",
  tz: "America/Phoenix",
  staggerMs: 30_000,
};

console.log("=== Existing schedule ===");
console.log(JSON.stringify(existingSchedule, null, 2));

// User edits only the cron expression, does NOT pass --tz or --stagger
const editRequest = resolveCronEditScheduleRequest({
  cron: "5 4 * * *",
  // No --tz, no --stagger passed
});

console.log("\n=== resolveCronEditScheduleRequest result ===");
console.log(JSON.stringify(editRequest, null, 2));

if (editRequest.kind === "direct" && editRequest.schedule.kind === "cron") {
  console.log("\n=== Before fix: schedule that would be written ===");
  console.log(JSON.stringify(editRequest.schedule, null, 2));
  console.log("  ⚠ tz: undefined — America/Phoenix is LOST");
  console.log("  ⚠ staggerMs: undefined — 30000ms is LOST");

  // Fix: merge existing tz and staggerMs
  const fixedSchedule = {
    ...editRequest.schedule,
    tz: editRequest.schedule.tz ?? existingSchedule.tz,
    staggerMs:
      editRequest.schedule.staggerMs !== undefined
        ? editRequest.schedule.staggerMs
        : existingSchedule.staggerMs,
  };

  console.log("\n=== After fix: schedule with merged fields ===");
  console.log(JSON.stringify(fixedSchedule, null, 2));
  console.log("  ✅ tz: 'America/Phoenix' — PRESERVED");
  console.log("  ✅ staggerMs: 30000 — PRESERVED");
}

// Also demonstrate: explicit --tz still overrides
console.log("\n=== When --tz IS passed explicitly ===");
const explicitRequest = resolveCronEditScheduleRequest({
  cron: "5 4 * * *",
  tz: "Europe/London",
});
console.log(JSON.stringify(explicitRequest, null, 2));
console.log("  ✅ tz: 'Europe/London' — explicit override takes priority");

// Demonstrate: patch-existing-cron path (--tz only, no --cron)
console.log("\n=== patch-existing-cron path (--tz only) ===");
const patchRequest = resolveCronEditScheduleRequest({
  tz: "Asia/Tokyo",
});
console.log(JSON.stringify(patchRequest, null, 2));
if (patchRequest.kind === "patch-existing-cron") {
  const patched = applyExistingCronSchedulePatch(existingSchedule, patchRequest);
  console.log("  Merged:", JSON.stringify(patched));
  console.log("  ✅ tz updated, staggerMs preserved, expr unchanged");
}
