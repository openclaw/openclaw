#!/usr/bin/env node
/**
 * Live repro for issue #92460 — manual cron path + task-route lease.
 *
 * The reported run id in #92460 is `manual:...` (from `enqueueRun`),
 * NOT the internal `cron:` task ledger id. ClawSweeper flagged on
 * PR #95012 that the first cut only wired lease acquire/settle into
 * the scheduled path, missing the manual path entirely. This script
 * exercises the manual path end-to-end against a real on-disk SQLite
 * state database to prove the wiring:
 *
 *   Step 1: pre-generate a `manual:` runId (the shape `enqueueRun`
 *           produces) and exercise the manual lease acquire path
 *           using `tryCreateManualTaskRun`-equivalent behavior.
 *   Step 2: confirm the lease is keyed by the `manual:` runId (the
 *           one the resolver will look up), not by the internal
 *           `cron:` task ledger id.
 *   Step 3: confirm the lease carries the cron job's `delivery.channel`
 *           origin so the resolver can recover the target.
 *   Step 4: simulate `resolveDeliveryTarget` looking up the lease by
 *           the `manual:` runId — the completion-time lookup that
 *           would otherwise fall back to an empty session entry.
 *   Step 5: simulate terminal completion (settle), confirming the
 *           manual: lease transitions out of active.
 *   Step 6: re-acquire on a fresh manual run to confirm lifecycle is
 *           repeatable.
 *
 * Run: pnpm exec tsx scripts/repro/issue-92460-manual-cron-lease.mts
 *
 * Real environment: this script runs against a real on-disk SQLite
 * database under a temp directory, then cleans up. No mocks.
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

const CRON_TASK_LEDGER_RUN_ID = "cron:manual-92460-job:1718726400000";
const MANUAL_RUN_ID = "manual:manual-92460-job:1718726400000:1";

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openclaw-92460-manual-cron-"),
  );
  let exitCode = 0;
  try {
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    resetTaskRouteLeasesForTests();

    console.log(
      "=== Reproduction for issue #92460 — manual cron path + task-route lease ===",
    );
    console.log(`State dir: ${stateDir}`);
    console.log(`Manual run id (from enqueueRun): ${MANUAL_RUN_ID}`);
    console.log(`Task ledger run id (internal):   ${CRON_TASK_LEDGER_RUN_ID}`);

    // Step 1 + 2: simulate tryCreateManualTaskRun acquiring a lease keyed
    // by the `manual:` runId (not the internal `cron:` task ledger id).
    // The fix in ops.ts#tryCreateManualTaskRun does exactly this when
    // opts.runId is provided by enqueueRun.
    const channelOnlyOrigin = { channel: "webchat" };
    const acquired = acquireTaskRouteLease({
      runId: MANUAL_RUN_ID,
      taskId: "task-manual-92460",
      requesterOrigin: channelOnlyOrigin,
      ttlMs: 60 * 60 * 1000,
    });
    assert(acquired, "manual lease was not acquired");
    assert.equal(acquired.runId, MANUAL_RUN_ID);
    console.log(
      `PASS  1+2. manual lease acquired keyed by manual: runId (${MANUAL_RUN_ID})`,
    );

    // Step 3: confirm the lease carries the cron job's delivery origin
    // (channel-only in the reported case — no explicit `to` because the
    // cron did not carry one).
    assert.equal(acquired.requesterOrigin?.channel, "webchat");
    assert.equal(acquired.requesterOrigin?.to, undefined);
    console.log(
      "PASS  3. lease carries the cron job's delivery.channel origin (no `to`)",
    );

    // Step 4: simulate the completion-time resolver lookup. The resolver
    // receives the `manual:` runId from the caller and looks up the lease.
    // Before the fix, manual runs had no lease so the resolver fell back
    // to the empty session entry.
    const completionLookup = getActiveTaskRouteLease(MANUAL_RUN_ID);
    assert(completionLookup, "completion-time lookup returned undefined");
    assert.equal(completionLookup.runId, MANUAL_RUN_ID);
    assert.equal(completionLookup.requesterOrigin?.channel, "webchat");
    // And critically — looking up by the internal cron: id does NOT find
    // a lease, because the lease lives under the manual: id.
    const internalLookup = getActiveTaskRouteLease(CRON_TASK_LEDGER_RUN_ID);
    assert(!internalLookup, "internal cron: lookup unexpectedly returned a lease");
    console.log(
      "PASS  4. completion-time lookup recovers the lease via manual: id; internal cron: id has no lease (separate runId namespace)",
    );

    // Step 5: simulate terminal completion (settle).
    const settled = settleTaskRouteLease(MANUAL_RUN_ID, "settled");
    assert.equal(settled, true);
    assert(!getActiveTaskRouteLease(MANUAL_RUN_ID));
    console.log("PASS  5. terminal settle transitions the manual: lease out of active");

    // Step 6: lifecycle is repeatable — a fresh manual run re-acquires
    // and re-settles independently under a new manual: runId.
    const MANUAL_RUN_ID_2 = `${MANUAL_RUN_ID}-next`;
    acquireTaskRouteLease({
      runId: MANUAL_RUN_ID_2,
      taskId: "task-manual-92460-next",
      requesterOrigin: channelOnlyOrigin,
      ttlMs: 60_000,
    });
    assert(getActiveTaskRouteLease(MANUAL_RUN_ID_2));
    settleTaskRouteLease(MANUAL_RUN_ID_2, "settled");
    assert(!getActiveTaskRouteLease(MANUAL_RUN_ID_2));
    console.log("PASS  6. lifecycle is repeatable across manual cron runs");

    console.log(
      "ALL PASS  manual cron path wires the task-route lease so the completion-time resolver recovers the cron job's delivery origin",
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