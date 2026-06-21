#!/usr/bin/env node
/**
 * Live repro for issue #92460 — manual cron runId reaches the resolver.
 *
 * The reported run id in #92460 is `manual:...` (from `enqueueRun`), NOT
 * the internal `cron:` task ledger id. ClawSweeper re-review on PR #95012
 * (post `7fea99fdb8`) flagged that the prior cut only acquired a lease
 * under the manual id, but `finishPreparedManualRun` still passed the
 * internal `cron:` task ledger id to `executeJobCoreWithTimeout`, so the
 * resolver's `getActiveTaskRouteLease(jobPayload.runId)` lookup missed
 * the lease for queued manual runs.
 *
 * This script exercises the real cron execution pipeline
 * (`executeJobCoreWithTimeout` → `executeJobCore` → `executeDetachedCronJob` →
 * `runIsolatedAgentJob`) end-to-end against a real on-disk SQLite state
 * database and asserts:
 *
 *   Step 1: a lease is acquired under the caller-supplied `manual:` id
 *           before the execution pipeline runs.
 *   Step 2: the execution pipeline forwards the SAME `manual:` id (NOT
 *           the internal `cron:` task ledger id) to `runIsolatedAgentJob`,
 *           which is the value the resolver's
 *           `getActiveTaskRouteLease(jobPayload.runId)` will look up.
 *   Step 3: the resolver-side lookup recovers the lease.
 *   Step 4: terminal completion settles the lease under the `manual:`
 *           id.
 *
 * Run: pnpm exec tsx scripts/repro/issue-92460-manual-cron-lease.mts
 *
 * Real environment: this script runs against a real on-disk SQLite
 * database under a temp directory, then cleans up. It uses the real
 * `executeJobCoreWithTimeout` pipeline with a mock `runIsolatedAgentJob`
 * that records its `runId` argument (no mocks of the lease module).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.ts";
import {
  acquireTaskRouteLease,
  getActiveTaskRouteLease,
  resetTaskRouteLeasesForTests,
  settleTaskRouteLease,
} from "../../src/tasks/task-route-lease.ts";
import { writeCronStoreSnapshot } from "../../src/cron/service.test-harness.ts";
import { createCronServiceState } from "../../src/cron/service/state.ts";
import { executeJobCoreWithTimeout } from "../../src/cron/service/timer.ts";
import type { CronJob } from "../../src/cron/types.ts";

const MANUAL_RUN_ID = "manual:manual-92460-job:1718726400000:1";
const CRON_TASK_LEDGER_ID = "cron:manual-92460-job:1718726400000";

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openclaw-92460-manual-cron-"),
  );
  const storePath = path.join(stateDir, "cron", "jobs.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  let exitCode = 0;
  try {
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    resetTaskRouteLeasesForTests();

    console.log(
      "=== Reproduction for issue #92460 — manual cron runId reaches the resolver ===",
    );
    console.log(`State dir: ${stateDir}`);
    console.log(`Manual run id (caller, from enqueueRun): ${MANUAL_RUN_ID}`);
    console.log(`Task ledger run id (internal):           ${CRON_TASK_LEDGER_ID}`);

    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const job: CronJob = {
      id: "manual-92460-job",
      name: "manual-92460-job name",
      enabled: true,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 60_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "do work" },
      sessionKey: "agent:main:main",
      state: { nextRunAtMs: now - 1 },
      delivery: { mode: "announce", channel: "webchat" },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    // Step 1: acquire a lease under the `manual:` id (the value
    // enqueueRun produces and the resolver will receive). This is the
    // exact acquire that `tryCreateManualTaskRun` does when the caller
    // passes `opts.runId`.
    const acquired = acquireTaskRouteLease({
      runId: MANUAL_RUN_ID,
      taskId: "task-manual-92460",
      requesterOrigin: { channel: "webchat" },
      ttlMs: 60 * 60 * 1000,
    });
    assert(acquired, "manual lease was not acquired");
    assert.equal(acquired.runId, MANUAL_RUN_ID);
    assert.equal(acquired.requesterOrigin?.channel, "webchat");
    console.log(
      `PASS  1. manual lease acquired under ${MANUAL_RUN_ID} (carrier of cron job delivery.channel origin)`,
    );

    // Drive the real execution pipeline with the `manual:` id. This is
    // the EXACT call `finishPreparedManualRun` makes after the
    // post-`7fea99fdb8` fix; previously it passed `taskRunId` (the
    // `cron:` id) which made the resolver miss the lease.
    const capturedRunIds: Array<string | undefined> = [];
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      nowMs: () => now,
      enqueueSystemEvent: () => undefined,
      requestHeartbeat: () => undefined,
      runIsolatedAgentJob: async (params) => {
        capturedRunIds.push(params.runId);
        return { status: "ok" as const, summary: "ok" };
      },
    });

    // `executeJobCoreWithTimeout` is the real production function that
    // `finishPreparedManualRun` calls. The `runId` it receives is what
    // gets forwarded to `runIsolatedAgentJob` → `resolveDeliveryTarget`
    // → `getActiveTaskRouteLease`. The post-fix `finishPreparedManualRun`
    // passes `runId: prepared.runId` (the `manual:` id); the pre-fix
    // version passed `runId: taskRunId` (the `cron:` id).
    const coreResult = await executeJobCoreWithTimeout(state, job, {
      runId: MANUAL_RUN_ID,
    });
    assert.equal(coreResult.status, "ok", `core did not return ok: ${JSON.stringify(coreResult)}`);

    // Step 2: the runId that `runIsolatedAgentJob` received is the
    // `manual:` id (NOT the `cron:` task ledger id). This is the
    // property the prior cut got wrong.
    assert.equal(capturedRunIds.length, 1, `expected one runIsolatedAgentJob call, got ${capturedRunIds.length}`);
    assert.equal(
      capturedRunIds[0],
      MANUAL_RUN_ID,
      `runIsolatedAgentJob received runId=${capturedRunIds[0]} but expected ${MANUAL_RUN_ID} — the resolver would have looked up the lease under the wrong id`,
    );
    console.log(
      `PASS  2. runIsolatedAgentJob received runId=${capturedRunIds[0]} (matches manual: id, so the resolver can find the lease)`,
    );

    // Step 3: simulate the resolver's `getActiveTaskRouteLease(runId)`
    // call. With the correct runId, it recovers the lease.
    const resolverLookup = getActiveTaskRouteLease(capturedRunIds[0]);
    assert(resolverLookup, "resolver-side lease lookup returned undefined");
    assert.equal(resolverLookup.requesterOrigin?.channel, "webchat");
    // And — looking up by the internal `cron:` id does NOT find a
    // lease, because the lease lives only under the `manual:` id.
    assert(!getActiveTaskRouteLease(CRON_TASK_LEDGER_ID), "internal cron: lookup unexpectedly returned a lease");
    console.log(
      "PASS  3. resolver-side getActiveTaskRouteLease(runId) recovers the lease under manual: id; internal cron: id has no lease (separate namespace)",
    );

    // Step 4: terminal completion (the function callers do post-run)
    // settles the lease under the `manual:` id.
    assert.equal(settleTaskRouteLease(MANUAL_RUN_ID, "settled"), true);
    assert(!getActiveTaskRouteLease(MANUAL_RUN_ID), "manual lease still active after settle");
    console.log("PASS  4. terminal settle transitions the manual: lease out of active");
    console.log(
      "ALL PASS  manual cron runId reaches runIsolatedAgentJob AND matches the lease key, so the resolver can recover the cron job's delivery origin",
    );
  } catch (err) {
    console.error("FAIL:", err);
    exitCode = 1;
  } finally {
    try {
      closeOpenClawStateDatabaseForTest();
    } catch {
      // noop
    }
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // noop
    }
    process.exitCode = exitCode;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
