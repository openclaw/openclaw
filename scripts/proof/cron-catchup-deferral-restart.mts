// Real behavior proof for #102236: a persisted startup catch-up deferral
// marker survives a simulated process restart so the staggered catch-up slot
// is not advanced to the next natural run by start-time maintenance.
//
// Drives the real production cron service path (createCronServiceState ->
// ensureLoaded -> recomputeNextRunsForMaintenance) against a real on-disk
// SQLite store, with no job execution (runIsolatedAgentJob is a stub).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recomputeNextRunsForMaintenance } from "../../src/cron/service/jobs.js";
import { createCronServiceState, type CronServiceDeps } from "../../src/cron/service/state.js";
import { ensureLoaded, persist } from "../../src/cron/service/store.js";
import {
  loadCronCatchupDeferralFile,
  resolveCronCatchupDeferralPath,
  saveCronCatchupDeferralFile,
  saveCronStore,
} from "../../src/cron/store.js";

const NOW = Date.parse("2026-03-23T12:00:00.000Z");
// A non-natural near-future slot, like the staggered `baseNow + offset` slot the
// scheduler parks overflow startup jobs in.
const DEFERRED_SLOT = NOW + 5_000;
// The next natural run of `0 9 * * *` from 2026-03-23T12:00:00Z is tomorrow 09:00.
const NATURAL_NEXT = Date.parse("2026-03-24T09:00:00.000Z");

const JOB = {
  id: "restart-deferred-daily",
  name: "restart deferred daily",
  enabled: true,
  createdAtMs: NOW - 60_000,
  updatedAtMs: NOW - 60_000,
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "systemEvent", text: "tick" },
  state: { nextRunAtMs: DEFERRED_SLOT },
} as const;

// Proof-only noop deps: this scenario never executes a job, it only loads the
// store and runs start-time maintenance recomputation.
const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};
const deps = {
  storePath: "",
  cronEnabled: true,
  log: noopLogger,
  nowMs: () => NOW,
  enqueueSystemEvent: () => ({ enqueued: false }),
  requestHeartbeat: () => undefined,
  runIsolatedAgentJob: async () => ({ status: "ok" as const }),
} as unknown as CronServiceDeps;

async function freshStorePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-cron-"));
  return path.join(dir, "cron", "jobs.json");
}

interface ScenarioResult {
  label: string;
  markerLoadedFromDisk: number;
  nextRunAtMsAfterMaintenance: number | undefined;
  slotSurvived: boolean;
}

async function runScenario(label: string, withSidecar: boolean): Promise<ScenarioResult> {
  const storePath = await freshStorePath();
  deps.storePath = storePath;

  await saveCronStore(storePath, { version: 1, jobs: [{ ...JOB }] });
  if (withSidecar) {
    saveCronCatchupDeferralFile({ storePath, jobIds: new Set([JOB.id]) });
  }

  // Fresh process: in-memory marker set starts empty, then loads from disk.
  const state = createCronServiceState(deps);
  await ensureLoaded(state, { skipRecompute: true });
  const markerLoadedFromDisk = state.pendingCatchupDeferralJobIds.size;

  recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
  const job = state.store?.jobs.find((entry) => entry.id === JOB.id);
  const nextRunAtMsAfterMaintenance = job?.state.nextRunAtMs;

  return {
    label,
    markerLoadedFromDisk,
    nextRunAtMsAfterMaintenance,
    slotSurvived: nextRunAtMsAfterMaintenance === DEFERRED_SLOT,
  };
}

const withSidecar = await runScenario("WITH persisted sidecar (fix applied)", true);
const control = await runScenario("WITHOUT sidecar (control)", false);

const sidecarRoundTrip = await (async () => {
  const storePath = await freshStorePath();
  deps.storePath = storePath;
  const sidecarPath = resolveCronCatchupDeferralPath(storePath);
  const state = createCronServiceState(deps);
  await ensureLoaded(state, { skipRecompute: true });
  state.pendingCatchupDeferralJobIds.add("drained-job");
  await persist(state);
  const written = [...loadCronCatchupDeferralFile(sidecarPath)];
  state.pendingCatchupDeferralJobIds.delete("drained-job");
  await persist(state);
  let sidecarRemoved = false;
  try {
    await fs.stat(sidecarPath);
  } catch (err) {
    sidecarRemoved = (err as { code?: string }).code === "ENOENT";
  }
  return { written, sidecarRemoved };
})();

const render = (value: number | undefined): string =>
  value === undefined ? "undefined" : String(value);

console.log("#102236 cron startup catch-up deferral — cross-restart proof\n");
console.log(`NOW (fresh process start)      = ${NOW}`);
console.log(`DEFERRED catch-up slot         = ${DEFERRED_SLOT}  (NOW + 5s)`);
console.log(`NATURAL next run (0 9 * * *)   = ${NATURAL_NEXT}  (tomorrow 09:00)\n`);

for (const r of [withSidecar, control]) {
  console.log(`## ${r.label}`);
  console.log(`  markers loaded from disk     = ${r.markerLoadedFromDisk}`);
  console.log(`  nextRunAtMs after maintenance = ${render(r.nextRunAtMsAfterMaintenance)}`);
  console.log(`  deferred slot survived?       = ${r.slotSurvived}`);
  console.log("");
}

console.log("## sidecar round-trip (persist -> reload -> drain)");
console.log(`  sidecar written ids          = ${JSON.stringify(sidecarRoundTrip.written)}`);
console.log(`  sidecar removed once drained = ${sidecarRoundTrip.sidecarRemoved}`);
