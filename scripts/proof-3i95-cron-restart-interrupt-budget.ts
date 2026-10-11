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
 *
 * Run: pnpm tsx scripts/proof-3i95-cron-restart-interrupt-budget.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CronService } from "../src/cron/service.js";
import { createCronServiceState } from "../src/cron/service/state.js";
import { applyJobResult } from "../src/cron/service/timer-outcomes.js";
import { loadCronStore, saveCronStore } from "../src/cron/store.js";
import type { CronJob } from "../src/cron/types.js";
import { GatewayScheduler } from "../src/infra/gateway-scheduler.js";

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
      repaired.enabled === true,
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
  const enabledAfterRestart = afterRestart.enabled;
  assert(
    enabledAfterRestart === true,
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

  assert(afterRestart.enabled === false, "the tenth genuine failure did not auto-disable the job");
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
  assert(job.enabled === false, "an uninterrupted ten-failure streak no longer auto-disables");
  assert(
    job.state.autoDisabled?.consecutiveErrors === 10,
    "auto-disable evidence changed for an uninterrupted streak",
  );

  console.log("  scenario 3: uninterrupted tenth genuine failure still auto-disables");
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
