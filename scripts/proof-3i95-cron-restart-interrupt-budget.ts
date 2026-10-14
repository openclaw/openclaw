/**
 * Real-behavior proof for openclaw-3i95: gateway restarts must not auto-disable
 * a healthy recurring automation.
 *
 * Real (not stubbed):
 * - The production `CronService` facade and its real `start()` startup repair,
 *   which is what detects a persisted `running` marker and calls
 *   `markInterruptedStartupRun`.
 * - The real on-disk cron store (`loadCronStore` / `saveCronStore`) under a temp
 *   dir, so every restart round-trips job state through real persistence. This
 *   also proves the new report-only state fields survive the store, rather than
 *   living only in memory.
 * - The real `applyJobResult` run-outcome path and the real
 *   `maybeAutoDisableCronJobAfterRunFailure` budget decision.
 *
 * Stubbed only at the edge:
 * - `runIsolatedAgentJob` / `enqueueSystemEvent` / `requestHeartbeat` are inert
 *   so the proof never launches an agent turn or delivers a notification. The
 *   scheduler is left paused, so no job is executed by wall-clock; every run
 *   outcome in this proof is applied explicitly.
 *
 * Scenarios:
 *  1. Twelve consecutive gateway restarts interrupt a running `every` job.
 *     Before the fix this reached `consecutiveErrors = 10` and auto-disabled at
 *     the tenth restart. It must now stay enabled, with the interruption streak
 *     recorded separately and the last run marked `gateway-restart`.
 *  2. Nine genuine run failures, then a restart interruption, then a tenth
 *     genuine failure. The restart must not pay for a failure: the job survives
 *     the interruption and is auto-disabled only by the tenth real failure, and
 *     the recorded `autoDisabled.consecutiveErrors` counts real failures only.
 *  3. A job with no interruptions in its streak auto-disables on its tenth
 *     genuine failure exactly as before, proving the regression direction.
 *  4. A run that reports its own outcome clears the interruption streak, so
 *     restarts cannot accumulate across healthy runs.
 *  5. A quiet (non-firing) trigger evaluation after a real restart clears the
 *     error streak, so the interruption offset it was subtracted from must go
 *     with it; ten later genuine failures then still auto-disable on the tenth.
 *  6. A persisted v2026.9.9 row (eight genuine failures plus one gateway
 *     restart, no offset) is repaired by the real `openclaw doctor --fix` cron
 *     path — `loadLegacyCronRepairState` then `applyLegacyCronStoreRepair`,
 *     including its pre-repair backup and snapshot guards — and the repair is
 *     then read back out of the store. This crosses the existing-row write that
 *     `preserveRuntimeState` governs, which the earlier version of this
 *     scenario did not: it normalized in memory and re-saved by hand, so it
 *     certified a repair the operator's store never received. The scenario runs
 *     its own control first, showing the un-repaired row disabling on the ninth
 *     genuine failure, and then that the repaired row still auto-disables on
 *     the tenth.
 *  7. The scheduler commits a successful run between Doctor's read and its
 *     write. Doctor's snapshot guard fingerprints definitions only, so that
 *     write is invisible to it; the repair must leave the cleared streak alone
 *     instead of restoring Doctor's stale view of the row.
 *
 * Run: pnpm tsx scripts/proof-3i95-cron-restart-interrupt-budget.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyLegacyCronStoreRepair,
  loadLegacyCronRepairState,
} from "../src/commands/doctor/cron/legacy-repair.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { CronService } from "../src/cron/service.js";
import { createCronServiceState } from "../src/cron/service/state.js";
import { applyJobResult, applyTriggerNoFireResult } from "../src/cron/service/timer-outcomes.js";
import { loadCronStore, saveCronStore } from "../src/cron/store.js";
import { cronStoreKey } from "../src/cron/store/key.js";
import type { CronJob } from "../src/cron/types.js";
import { GatewayScheduler } from "../src/infra/gateway-scheduler.js";
import { openOpenClawStateDatabase } from "../src/state/openclaw-state-db.js";

// Isolate every durable side effect from the operator's real state directory.
// The state database is opened lazily, so setting this before any cron call is
// enough to keep the proof self-contained.
const PROOF_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "proof-3i95-"));
process.env.OPENCLAW_STATE_DIR = path.join(PROOF_TMP_DIR, "state");
fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true });

const BASE_MS = Date.parse("2026-09-16T12:00:00.000Z");
const EVERY_MS = 60_000;

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

/**
 * Reads a live counter without letting an earlier assertion narrow it. `assert`
 * is an assertion signature, so asserting `job.state.x === 1` narrows that
 * property to the literal `1` for the rest of the scope and a later
 * `=== 0` on the mutated value is then rejected as a dead comparison.
 */
function readCounter(
  job: CronJob,
  key: "consecutiveErrors" | "consecutiveRestartInterruptions",
): number | undefined {
  return job.state[key];
}

/** Reads the live enabled flag; see `readCounter` for why this is a function. */
function readEnabled(job: CronJob): boolean {
  return job.enabled;
}

function recurringJob(id: string, runningAtMs: number, state: CronJob["state"]): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: runningAtMs - EVERY_MS,
    updatedAtMs: runningAtMs,
    schedule: { kind: "every", everyMs: EVERY_MS, anchorMs: runningAtMs - EVERY_MS },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: `tick-${id}` },
    state,
  };
}

function offlineServiceState(storePath: string, nowMs: number) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: noopLog,
    nowMs: () => nowMs,
    scheduler: new GatewayScheduler(),
    enqueueSystemEvent: () => {},
    requestHeartbeat: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" as const }),
  });
}

/** Boots the real CronService against the store, runs startup repair, stops it. */
async function restartGateway(storePath: string, nowMs: number): Promise<CronJob> {
  const service = new CronService({
    storePath,
    cronEnabled: true,
    log: noopLog,
    nowMs: () => nowMs,
    scheduler: new GatewayScheduler(),
    enqueueSystemEvent: (() => {}) as never,
    requestHeartbeat: (() => {}) as never,
    runIsolatedAgentJob: (async () => ({ status: "ok" as const })) as never,
  });
  // Keep the timer from executing the job: this proof is about startup repair,
  // not about what a replayed run would have produced.
  service.pauseScheduling();
  await service.start();
  service.stop();
  const store = await loadCronStore(storePath);
  const job = store.jobs[0];
  assert(job, "expected the repaired job to remain in the store");
  return job;
}

async function scenarioRepeatedRestarts(tmpDir: string): Promise<void> {
  const storePath = path.join(tmpDir, "repeated-restarts.json");
  const job = recurringJob("restart-only", BASE_MS, {
    nextRunAtMs: BASE_MS,
    runningAtMs: BASE_MS,
  });
  await saveCronStore(storePath, { version: 1, jobs: [job] });

  let repaired = job;
  for (let restart = 1; restart <= 12; restart += 1) {
    const nowMs = BASE_MS + restart * EVERY_MS;
    repaired = await restartGateway(storePath, nowMs);
    assert(
      readEnabled(repaired),
      `restart ${restart} disabled a healthy job (autoDisabled=${JSON.stringify(repaired.state.autoDisabled)})`,
    );
    assert(
      repaired.state.autoDisabled === undefined,
      `restart ${restart} recorded an auto-disable fact`,
    );
    assert(
      repaired.state.lastRunInterruptionReason === "gateway-restart",
      `restart ${restart} lost the structured interruption reason`,
    );
    assert(
      repaired.state.consecutiveRestartInterruptions === restart,
      `restart ${restart} did not persist its interruption streak (got ${repaired.state.consecutiveRestartInterruptions})`,
    );
    assert(
      repaired.state.consecutiveErrors === restart,
      `restart ${restart} error streak drifted (got ${repaired.state.consecutiveErrors})`,
    );
    // Re-arm the running marker for the next simulated restart.
    repaired.state.runningAtMs = BASE_MS + restart * EVERY_MS;
    repaired.state.nextRunAtMs = BASE_MS + restart * EVERY_MS;
    await saveCronStore(storePath, { version: 1, jobs: [repaired] });
  }

  console.log(
    `  scenario 1: survived 12 gateway restarts (consecutiveErrors=${repaired.state.consecutiveErrors}, restartInterruptions=${repaired.state.consecutiveRestartInterruptions}, enabled=${repaired.enabled})`,
  );
}

async function scenarioRestartDoesNotPayForFailure(tmpDir: string): Promise<void> {
  const storePath = path.join(tmpDir, "mixed-streak.json");
  // Nine genuine failures already on the streak, none of them infrastructure.
  const job = recurringJob("mixed-streak", BASE_MS, {
    nextRunAtMs: BASE_MS,
    runningAtMs: BASE_MS,
    consecutiveErrors: 9,
    lastErrorReason: "timeout",
  });
  await saveCronStore(storePath, { version: 1, jobs: [job] });

  const afterRestart = await restartGateway(storePath, BASE_MS + EVERY_MS);
  assert(
    readEnabled(afterRestart),
    "a gateway restart spent the tenth run-failure slot of a nine-failure streak",
  );
  assert(
    afterRestart.state.consecutiveErrors === 10,
    `expected the raw error streak to reach 10, got ${afterRestart.state.consecutiveErrors}`,
  );
  assert(
    afterRestart.state.consecutiveRestartInterruptions === 1,
    `expected exactly one restart interruption, got ${afterRestart.state.consecutiveRestartInterruptions}`,
  );

  const startedAt = BASE_MS + 2 * EVERY_MS;
  const endedAt = startedAt + 500;
  const state = offlineServiceState(storePath, endedAt);
  applyJobResult(
    state,
    afterRestart,
    {
      status: "error",
      error: "provider refused the request",
      executionStarted: true,
      startedAt,
      endedAt,
    },
    { deferredNotifications: [] },
  );

  assert(!readEnabled(afterRestart), "the tenth genuine failure did not auto-disable the job");
  assert(
    afterRestart.state.autoDisabled?.reason === "consecutive-failures",
    "auto-disable did not record the consecutive-failures reason",
  );
  assert(
    afterRestart.state.autoDisabled?.consecutiveErrors === 10,
    `auto-disable reported ${afterRestart.state.autoDisabled?.consecutiveErrors} failures instead of the 10 real ones`,
  );
  assert(
    afterRestart.state.lastRunInterruptionReason === undefined,
    "a completed run left the stale gateway-restart interruption reason behind",
  );

  console.log(
    "  scenario 2: restart survived, tenth genuine failure auto-disabled with consecutiveErrors=10",
  );
}

function scenarioGenuineStreakUnchanged(tmpDir: string): void {
  const storePath = path.join(tmpDir, "genuine-streak.json");
  const startedAt = BASE_MS + EVERY_MS;
  const endedAt = startedAt + 500;
  const job = recurringJob("genuine-streak", BASE_MS, {
    nextRunAtMs: startedAt,
    runningAtMs: startedAt,
    consecutiveErrors: 9,
  });
  const state = offlineServiceState(storePath, endedAt);

  applyJobResult(
    state,
    job,
    {
      status: "error",
      error: "provider refused the request",
      executionStarted: true,
      startedAt,
      endedAt,
    },
    { deferredNotifications: [] },
  );

  assert(job.state.consecutiveErrors === 10, "genuine failure counting regressed");
  assert(!readEnabled(job), "an uninterrupted ten-failure streak no longer auto-disables");
  assert(
    job.state.autoDisabled?.consecutiveErrors === 10,
    "auto-disable evidence changed for an uninterrupted streak",
  );

  console.log("  scenario 3: uninterrupted tenth genuine failure still auto-disables");
}

/** Applies one genuine run failure through the real run-outcome owner. */
function applyGenuineFailure(
  state: ReturnType<typeof offlineServiceState>,
  job: CronJob,
  index: number,
): void {
  const startedAt = BASE_MS + (index + 1) * EVERY_MS;
  applyJobResult(
    state,
    job,
    {
      status: "error",
      error: "provider refused the request",
      executionStarted: true,
      startedAt,
      endedAt: startedAt + 500,
    },
    { deferredNotifications: [] },
  );
}

async function scenarioQuietTriggerClearsOffset(tmpDir: string): Promise<void> {
  const storePath = path.join(tmpDir, "quiet-trigger.json");
  const endedAt = BASE_MS + 1_000;
  const job = recurringJob("quiet-trigger", BASE_MS, {
    nextRunAtMs: BASE_MS,
    runningAtMs: BASE_MS,
  });
  await saveCronStore(storePath, { version: 1, jobs: [job] });

  // One real gateway restart records the interruption through startup repair.
  const interrupted = await restartGateway(storePath, BASE_MS + 30_000);
  assert(
    readCounter(interrupted, "consecutiveRestartInterruptions") === 1,
    "the restart did not record an interruption offset",
  );

  // A non-firing trigger evaluation is successful scheduler work: it clears the
  // error streak, so the offset it was subtracted from no longer exists.
  const state = offlineServiceState(storePath, endedAt);
  applyTriggerNoFireResult(
    state,
    interrupted,
    {
      startedAt: BASE_MS,
      endedAt,
      // `busy` is `busy?: true`, so a non-busy evaluation omits it entirely.
      triggerEval: { fired: false, stateChanged: false },
    },
    { deferredNotifications: [] },
  );
  assert(
    readCounter(interrupted, "consecutiveErrors") === 0,
    "the quiet trigger tick did not clear the error streak",
  );
  assert(
    readCounter(interrupted, "consecutiveRestartInterruptions") === 0,
    "the quiet trigger tick left a stale interruption offset",
  );

  await saveCronStore(storePath, { version: 1, jobs: [interrupted] });
  const reloaded = (await loadCronStore(storePath)).jobs[0];
  assert(reloaded, "expected the quiet-trigger job to survive the store");
  for (let failure = 0; failure < 10 && readEnabled(reloaded); failure += 1) {
    applyGenuineFailure(state, reloaded, failure);
  }
  assert(
    readCounter(reloaded, "consecutiveErrors") === 10,
    "the post-tick failure streak did not reach ten genuine failures",
  );
  assert(
    !readEnabled(reloaded),
    "a stale interruption offset survived the quiet tick and delayed auto-disable",
  );

  console.log(
    "  scenario 5: a quiet trigger tick clears the offset; ten later genuine failures still auto-disable",
  );
}

/** Drives the production `openclaw doctor --fix` cron repair over one store. */
async function loadDoctorRepairState(storePath: string) {
  const cfg = { cron: { store: storePath } } as OpenClawConfig;
  const state = await loadLegacyCronRepairState({ cfg, storePath });
  assert(state, `doctor could not load repair state for ${storePath}`);
  return { cfg, state };
}

async function repairLegacyStore(storePath: string) {
  return await applyLegacyCronStoreRepair(await loadDoctorRepairState(storePath));
}

async function scenarioLegacyUpgradeKeepsBudget(tmpDir: string): Promise<void> {
  // A v2026.9.9 row: eight genuine failures plus one gateway restart, recorded
  // before the interruption counters existed, so there is no offset at all.
  const legacyState = {
    nextRunAtMs: BASE_MS,
    consecutiveErrors: 9,
    lastRunStatus: "error" as const,
    lastStatus: "error" as const,
    lastError: "cron: job interrupted by gateway restart",
  };

  // Control: without normalization the next genuine failure is the tenth the
  // budget can see, so an upgraded healthy job dies one real failure early.
  const controlPath = path.join(tmpDir, "legacy-control.json");
  const controlJob = recurringJob("legacy-control", BASE_MS, { ...legacyState });
  await saveCronStore(controlPath, { version: 1, jobs: [controlJob] });
  const controlLoaded = (await loadCronStore(controlPath)).jobs[0];
  assert(controlLoaded, "expected the control job to survive the store");
  applyGenuineFailure(offlineServiceState(controlPath, BASE_MS), controlLoaded, 0);
  assert(
    !readEnabled(controlLoaded),
    "control invalid: an un-normalized legacy row should disable on its ninth genuine failure",
  );

  // The real upgrade path: the legacy row is already persisted, and `openclaw
  // doctor --fix` repairs it in place. Going through `applyLegacyCronStoreRepair`
  // rather than calling the migration owner and re-saving by hand is the point
  // of this scenario — Doctor saves with `preserveRuntimeState`, so the existing
  // row's conflict update excludes `state_json` and an earlier version of this
  // scenario certified a repair the operator's store never received.
  const storePath = path.join(tmpDir, "legacy-upgrade.json");
  await saveCronStore(storePath, {
    version: 1,
    jobs: [recurringJob("legacy-upgrade", BASE_MS, { ...legacyState })],
  });
  const repaired = await repairLegacyStore(storePath);
  assert(
    repaired.warnings.length === 0,
    `doctor reported warnings while repairing the legacy row: ${repaired.warnings.join("; ")}`,
  );

  // Read the operator's store back, not doctor's in-memory result: the defect
  // this scenario pins was entirely in the write.
  const job = (await loadCronStore(storePath)).jobs[0];
  assert(job, "expected the repaired job to survive the store");
  assert(
    readCounter(job, "consecutiveRestartInterruptions") === 1,
    "doctor's repaired interruption offset did not survive the existing-row write",
  );
  assert(
    job.state.lastRunInterruptionReason === "gateway-restart",
    "doctor's repaired interruption reason did not survive the existing-row write",
  );
  assert(
    repaired.changes.some((change) => change.includes("gateway-restart interruption")),
    "doctor did not report persisting the legacy gateway-restart interruption",
  );
  const state = offlineServiceState(storePath, BASE_MS);
  applyGenuineFailure(state, job, 0);
  assert(
    readEnabled(job),
    "the upgraded job lost a genuine failure to the retained restart interruption",
  );
  applyGenuineFailure(state, job, 1);
  assert(!readEnabled(job), "the upgraded job did not auto-disable on its tenth genuine failure");
  assert(
    job.state.autoDisabled?.consecutiveErrors === 10,
    "the upgraded job's auto-disable evidence did not count ten genuine failures",
  );

  console.log(
    "  scenario 6: doctor --fix persists the upgrade repair; the row keeps its full budget and still disables on the tenth genuine failure",
  );
}

async function scenarioRepairPreservesConcurrentRuntimeState(tmpDir: string): Promise<void> {
  const storePath = path.join(tmpDir, "legacy-concurrent.json");
  await saveCronStore(storePath, {
    version: 1,
    jobs: [
      recurringJob("legacy-concurrent", BASE_MS, {
        nextRunAtMs: BASE_MS,
        consecutiveErrors: 9,
        lastRunStatus: "error" as const,
        lastStatus: "error" as const,
        lastError: "cron: job interrupted by gateway restart",
      }),
    ],
  });
  const { cfg, state } = await loadDoctorRepairState(storePath);

  // The scheduler commits a successful run while doctor is still deciding.
  // `preserveRuntimeState` exists for exactly this, and doctor's snapshot guard
  // fingerprints definitions only, so this write is invisible to it: persisting
  // doctor's earlier read wholesale would resurrect the streak that just
  // cleared and attribute an interruption to a job that no longer has one.
  const scheduled = { nextRunAtMs: BASE_MS + EVERY_MS, consecutiveErrors: 0, lastRunStatus: "ok" };
  openOpenClawStateDatabase()
    .db.prepare(`UPDATE cron_jobs SET state_json = ? WHERE store_key = ? AND job_id = ?`)
    .run(JSON.stringify(scheduled), cronStoreKey(storePath), "legacy-concurrent");

  const repaired = await applyLegacyCronStoreRepair({ cfg, state });
  assert(
    repaired.warnings.length === 0,
    `doctor reported warnings while repairing a concurrently updated row: ${repaired.warnings.join("; ")}`,
  );

  const job = (await loadCronStore(storePath)).jobs[0];
  assert(job, "expected the concurrently updated job to survive the repair");
  assert(
    readCounter(job, "consecutiveErrors") === 0,
    "doctor's stale read overwrote the successful run the scheduler had committed",
  );
  assert(
    readCounter(job, "consecutiveRestartInterruptions") === undefined,
    "doctor attributed an interruption to a streak that no longer existed at write time",
  );

  console.log(
    "  scenario 7: doctor's repair leaves a run the scheduler committed after the snapshot intact",
  );
}

function scenarioSuccessClearsStreak(tmpDir: string): void {
  const storePath = path.join(tmpDir, "recovery.json");
  const startedAt = BASE_MS + EVERY_MS;
  const endedAt = startedAt + 500;
  const job = recurringJob("recovery", BASE_MS, {
    nextRunAtMs: startedAt,
    runningAtMs: startedAt,
    consecutiveErrors: 4,
    consecutiveRestartInterruptions: 4,
    lastRunInterruptionReason: "gateway-restart",
  });
  const state = offlineServiceState(storePath, endedAt);

  applyJobResult(state, job, { status: "ok", startedAt, endedAt }, { deferredNotifications: [] });

  assert(job.state.consecutiveErrors === 0, "a successful run did not clear the error streak");
  assert(
    job.state.consecutiveRestartInterruptions === 0,
    "a successful run did not clear the restart-interruption streak",
  );
  assert(
    job.state.lastRunInterruptionReason === undefined,
    "a successful run did not clear the interruption reason",
  );

  console.log("  scenario 4: a completed run clears both the error and interruption streaks");
}

async function main(): Promise<void> {
  const tmpDir = PROOF_TMP_DIR;
  try {
    console.log("proof-3i95: cron restart interruptions must not spend the auto-disable budget");
    await scenarioRepeatedRestarts(tmpDir);
    await scenarioRestartDoesNotPayForFailure(tmpDir);
    scenarioGenuineStreakUnchanged(tmpDir);
    scenarioSuccessClearsStreak(tmpDir);
    await scenarioQuietTriggerClearsOffset(tmpDir);
    await scenarioLegacyUpgradeKeepsBudget(tmpDir);
    await scenarioRepairPreservesConcurrentRuntimeState(tmpDir);
    console.log("All runtime assertions passed.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  },
);
