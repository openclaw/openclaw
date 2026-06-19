#!/usr/bin/env node
/**
 * Runtime proof: startup overflow catch-up deferral survives cron list/status
 *
 * Standalone — no vitest dependency. Uses the actual CronService modules
 * directly with node + tsx.
 *
 * Usage: node --import tsx scripts/runtime-proof-overflow-deferral.mjs
 */

import { start } from "../src/cron/service/ops.js";
import { createCronServiceState } from "../src/cron/service/state.js";
import { onTimer } from "../src/cron/service/timer.js";
import { recomputeNextRunsForMaintenance } from "../src/cron/service/jobs.js";
import { saveCronStore } from "../src/cron/store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE = "2025-12-13T17:00:00.000Z";
const startNow = Date.parse(BASE);
const tomorrowNatural = Date.parse("2025-12-14T09:00:00.000Z");
const STAGGERED_SLOT = startNow + 5_000;

function log(step, msg) {
  console.log(`  ${msg}`);
}

function hr() {
  console.log(`  ` + `─`.repeat(60));
}

let now = startNow;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-runtime-proof-"));
const storePath = path.join(tmpDir, "cron-store.json");

console.log(`\n  ╔══════════════════════════════════════════════════════════╗`);
console.log(`  ║   Real Runtime Proof: Overflow Deferral Survival       ║`);
console.log(`  ╚══════════════════════════════════════════════════════════╝`);
console.log(`\n  Base time:  ${new Date(startNow).toISOString()}`);
console.log(`  Store:      ${storePath}`);

// Save overflow jobs: 5 hourly (missed) + 1 daily (overflow candidate)
await saveCronStore(storePath, {
  version: 1,
  jobs: [
    { id: "hourly-0", name: "hourly 0", enabled: true, createdAtMs: startNow - 14 * 3600_000, updatedAtMs: startNow - 14 * 3600_000, schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" }, sessionTarget: "main", wakeMode: "next-heartbeat", payload: { kind: "systemEvent", text: "tick" }, state: { nextRunAtMs: startNow - 14 * 3600_000 } },
    { id: "hourly-1", name: "hourly 1", enabled: true, createdAtMs: startNow - 13 * 3600_000, updatedAtMs: startNow - 13 * 3600_000, schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" }, sessionTarget: "main", wakeMode: "next-heartbeat", payload: { kind: "systemEvent", text: "tick" }, state: { nextRunAtMs: startNow - 13 * 3600_000 } },
    { id: "hourly-2", name: "hourly 2", enabled: true, createdAtMs: startNow - 12 * 3600_000, updatedAtMs: startNow - 12 * 3600_000, schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" }, sessionTarget: "main", wakeMode: "next-heartbeat", payload: { kind: "systemEvent", text: "tick" }, state: { nextRunAtMs: startNow - 12 * 3600_000 } },
    { id: "hourly-3", name: "hourly 3", enabled: true, createdAtMs: startNow - 11 * 3600_000, updatedAtMs: startNow - 11 * 3600_000, schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" }, sessionTarget: "main", wakeMode: "next-heartbeat", payload: { kind: "systemEvent", text: "tick" }, state: { nextRunAtMs: startNow - 11 * 3600_000 } },
    { id: "hourly-4", name: "hourly 4", enabled: true, createdAtMs: startNow - 10 * 3600_000, updatedAtMs: startNow - 10 * 3600_000, schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" }, sessionTarget: "main", wakeMode: "next-heartbeat", payload: { kind: "systemEvent", text: "tick" }, state: { nextRunAtMs: startNow - 10 * 3600_000 } },
    { id: "daily-overflow", name: "daily overflow", enabled: true, createdAtMs: startNow - 7 * 24 * 3600_000, updatedAtMs: startNow - 7 * 24 * 3600_000, schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC", staggerMs: 0 }, sessionTarget: "main", wakeMode: "next-heartbeat", payload: { kind: "systemEvent", text: "tick" }, state: { nextRunAtMs: Date.parse("2025-12-13T09:00:00.000Z") } },
  ],
});

let state;
try {
  // ═══════════════════════════════════════════════════════════
  // STEP 1: Create CronService state and call start()
  // ═══════════════════════════════════════════════════════════
  hr();
  console.log(`  [STEP 1] CronService start() — overflow deferral assignment`);
  hr();

  state = createCronServiceState({
    cronEnabled: true,
    storePath,
    log: { debug: () => {}, info: (...a) => console.log(`         [cron]`, ...a), warn: (...a) => console.log(`         [cron:warn]`, ...a), error: (...a) => console.log(`         [cron:err]`, ...a) },
    nowMs: () => now,
    enqueueSystemEvent: () => {},
    requestHeartbeat: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });

  await start(state);

  const dailyAfterStart = state.store?.jobs.find((j) => j.id === "daily-overflow");
  log("", `daily-overflow nextRunAtMs AFTER start():`);
  log("", `  Actual:    ${dailyAfterStart?.state.nextRunAtMs}`);
  log("", `  Staggered: ${STAGGERED_SLOT}  (startNow + 5s)`);
  log("", `  Natural:   ${tomorrowNatural}  (tomorrow 09:00 UTC)`);
  log("", `  In pendingCatchupDeferralJobIds: ${state.pendingCatchupDeferralJobIds.has("daily-overflow")}`);

  if (dailyAfterStart?.state.nextRunAtMs !== STAGGERED_SLOT) {
    throw new Error(`Deferral not set correctly. Expected staggered ${STAGGERED_SLOT}`);
  }
  if (!state.pendingCatchupDeferralJobIds.has("daily-overflow")) {
    throw new Error("daily-overflow not in pendingCatchupDeferralJobIds after start()");
  }
  log(" ✅", `PASS: Deferral correctly set to staggered +5s slot.\n`);

  // ═══════════════════════════════════════════════════════════
  // STEP 2: Simulate cron.list() / cron.status() read-RPC
  // ═══════════════════════════════════════════════════════════
  hr();
  console.log(`  [STEP 2] Cron list/status read-RPC → recomputeNextRunsForMaintenance`);
  hr();

  recomputeNextRunsForMaintenance(state);

  const afterList = state.store?.jobs.find((j) => j.id === "daily-overflow");
  log("", `daily-overflow nextRunAtMs AFTER list/status recompute:`);
  log("", `  Actual:    ${afterList?.state.nextRunAtMs}`);
  log("", `  Expected:  ${STAGGERED_SLOT}  (unchanged)`);
  log("", `  In pendingCatchupDeferralJobIds: ${state.pendingCatchupDeferralJobIds.has("daily-overflow")}`);

  if (afterList?.state.nextRunAtMs !== STAGGERED_SLOT) {
    throw new Error(`❌ DEFERRAL CLOBBERED by list/status! Slot advanced from ${STAGGERED_SLOT} to ${afterList?.state.nextRunAtMs}`);
  }
  log(" ✅", `PASS: Deferral survived list/status recompute — staggered slot preserved.\n`);

  // ═══════════════════════════════════════════════════════════
  // STEP 3: Simulate finalizeCompletedResults / other callers
  // ═══════════════════════════════════════════════════════════
  hr();
  console.log(`  [STEP 3] Additional recompute calls (finalizeCompletedResults, etc.)`);
  hr();

  recomputeNextRunsForMaintenance(state);

  const afterFcr = state.store?.jobs.find((j) => j.id === "daily-overflow")?.state.nextRunAtMs;
  log("", `daily-overflow nextRunAtMs after 2nd recompute:`);
  log("", `  Actual:    ${afterFcr}`);
  log("", `  Expected:  ${STAGGERED_SLOT}  (still unchanged)`);

  if (afterFcr !== STAGGERED_SLOT) {
    throw new Error(`❌ DEFERRAL CLOBBERED by second recompute!`);
  }
  log(" ✅", `PASS: Deferral survived repeated recompute calls.\n`);

  // ═══════════════════════════════════════════════════════════
  // STEP 4: Advance clock past staggered slot → onTimer fires
  // ═══════════════════════════════════════════════════════════
  hr();
  console.log(`  [STEP 4] Staggered slot reached → onTimer tick`);
  hr();

  now = STAGGERED_SLOT + 5; // advance past staggered slot
  await onTimer(state);

  const completed = state.store?.jobs.find((j) => j.id === "daily-overflow");
  log("", `daily-overflow AFTER onTimer:`);
  log("", `  lastRunStatus: ${completed?.state.lastRunStatus}`);
  log("", `  nextRunAtMs:   ${completed?.state.nextRunAtMs}`);
  log("", `  Expected natural slot: ${tomorrowNatural}`);
  log("", `  In pendingCatchupDeferralJobIds: ${state.pendingCatchupDeferralJobIds.has("daily-overflow")}`);

  if (completed?.state.lastRunStatus !== "ok") {
    throw new Error(`Job did not fire successfully`);
  }
  if (completed?.state.nextRunAtMs !== tomorrowNatural) {
    throw new Error(`nextRunAtMs not advanced to natural slot`);
  }
  if (state.pendingCatchupDeferralJobIds.has("daily-overflow")) {
    throw new Error("pending id not cleaned up after job completion");
  }
  log(" ✅", `PASS: Job fired at staggered slot, deferral id cleaned up, next run = natural slot.\n`);

  // ═══════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════
  hr();
  console.log(`  [SUMMARY] All checks passed`);
  hr();
  console.log(`  ✅ Startup catch-up deferral correctly set to staggered +5s slot`);
  console.log(`  ✅ Deferral SURVIVES recomputeNextRunsForMaintenance (cron.list/status)`);
  console.log(`  ✅ Deferral SURVIVES repeated recompute calls (finalizeCompletedResults)`);
  console.log(`  ✅ Job fires at staggered slot when onTimer fires`);
  console.log(`  ✅ pending id cleaned up after job completion`);
  console.log(`  ✅ nextRunAtMs advances to natural next schedule after firing`);
  console.log(``);
  console.log(`  Without this fix, the Step 2 recompute would have advanced the`);
  console.log(`  deferred staggered slot (${STAGGERED_SLOT}) to the natural next`);
  console.log(`  slot (${tomorrowNatural}), silently dropping the missed daily run`);
  console.log(`  for a full period.`);
  console.log(``);

} finally {
  state.stopped = true;
  // Clean up temp files
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

console.log(`  Runtime proof complete. Temp store cleaned up.\n`);
