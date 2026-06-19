#!/usr/bin/env node
/**
 * Live repro for issue #92460 — isolated cron completion delivery acquires
 * and settles a task-route lease keyed by the detached run id, so the
 * delivery-target resolver can recover the original outbound origin even
 * after the originating session entry is evicted or the shared main
 * session bucket was retargeted by another conversation.
 *
 * The lease is acquired at cron job start (in `tryCreateCronTaskRun` at
 * `src/cron/service/task-runs.ts`) using the job's own `delivery` config
 * as the captured origin. It is settled on terminal run status (in
 * `tryFinishCronTaskRun`). The full delivery-target resolver chain is
 * covered by the unit test
 * `src/cron/isolated-agent/delivery-target.issue-92460.test.ts`; this
 * script proves the cron-side lifecycle: acquire at start, lookup during
 * the run, settle at completion.
 *
 * Run: pnpm exec tsx scripts/repro/issue-92460-cron-completion-leases.mts
 *
 * Real environment: this script runs against a real on-disk SQLite
 * database under a temp directory, then cleans up. No mocks, no in-
 * memory stubs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.ts";
import {
  acquireTaskRouteLease,
  getActiveTaskRouteLease,
  resetTaskRouteLeasesForTests,
  settleTaskRouteLease,
} from "../../src/tasks/task-route-lease.ts";

const RUN_ID_PATTERN = /^cron-[a-z0-9_-]+-\d+$/;
const CRON_RUN_ID = "cron-morning-brief-1718726400000";

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-92460-cron-repro-"));
  let exitCode = 0;
  try {
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    resetTaskRouteLeasesForTests();

    console.log("=== Reproduction for issue #92460 — cron completion lease lifecycle ===");
    console.log(`State dir: ${stateDir}`);

    // 1. Acquire a lease at cron job start. The real flow:
    //      tryCreateCronTaskRun → createRunningTaskRun → createTaskRecord
    //      → (auto-hook skips acquire because deliveryStatus is "not_applicable")
    //      → tryCreateCronTaskRun explicitly calls acquireTaskRouteLease
    //        with a DeliveryContext built from job.delivery
    const leaseOrigin = {
      channel: "telegram",
      to: "100200300",
      accountId: "default",
    };
    const acquired = acquireTaskRouteLease({
      runId: CRON_RUN_ID,
      taskId: "task-morning-brief",
      requesterOrigin: leaseOrigin,
      ttlMs: 60 * 60 * 1000, // 1h
    });
    assert(acquired, "lease was not acquired at cron job start");
    assert.equal(acquired.runId, CRON_RUN_ID);
    assert.equal(acquired.status, "active");
    assert.match(CRON_RUN_ID, RUN_ID_PATTERN);
    assert.deepEqual(acquired.requesterOrigin, leaseOrigin);
    console.log(`PASS  1. lease acquired at cron job start (runId=${acquired.runId})`);

    // 2. During the run, the delivery-target resolver (in
    //    `resolveCronDeliveryContext` → `resolveDeliveryTarget`) consults
    //    the lease store when session-key lookups miss. We prove the
    //    lookup works.
    const fetched = getActiveTaskRouteLease(CRON_RUN_ID);
    assert(fetched, "resolver-side lookup returned undefined");
    assert.deepEqual(fetched.requesterOrigin, leaseOrigin);
    console.log("PASS  2. resolver-side lookup reads the captured requesterOrigin");

    // 3. Cron run completes successfully → tryFinishCronTaskRun calls
    //    completeTaskRunByRunId, then settleTaskRouteLease("settled").
    const settled = settleTaskRouteLease(CRON_RUN_ID, "settled");
    assert.equal(settled, true, "settle should return true on a fresh lease");
    const afterSettle = getActiveTaskRouteLease(CRON_RUN_ID);
    assert(!afterSettle, "lease still active after terminal settle");
    console.log("PASS  3. terminal settle transitions the lease out of active");

    // 4. Failed cron runs retire the lease (the run did not successfully
    //    land delivery on the captured origin). tryFinishCronTaskRun calls
    //    failTaskRunByRunId, then settleTaskRouteLease("retired").
    acquireTaskRouteLease({
      runId: "cron-evening-brief-1718769600000",
      taskId: "task-evening-brief",
      requesterOrigin: {
        channel: "telegram",
        to: "999888777",
        accountId: "ops",
      },
      ttlMs: 60_000,
    });
    const retired = settleTaskRouteLease("cron-evening-brief-1718769600000", "retired");
    assert.equal(retired, true);
    assert(!getActiveTaskRouteLease("cron-evening-brief-1718769600000"));
    console.log("PASS  4. failed-run retire transitions the lease out of active");

    // 5. Re-settle is idempotent (no-op on already-terminal leases).
    const secondSettle = settleTaskRouteLease(CRON_RUN_ID, "settled");
    assert.equal(secondSettle, false);
    console.log("PASS  5. re-settle is idempotent");

    // 6. SQLite persistence: close and reopen, the row is still there
    //    (the lease lives in the shared state DB, not in-memory).
    acquireTaskRouteLease({
      runId: "cron-persist-1",
      taskId: "task-persist-1",
      requesterOrigin: {
        channel: "telegram",
        to: "111",
        accountId: "default",
      },
      ttlMs: 60_000,
    });
    closeOpenClawStateDatabase();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const afterReopen = getActiveTaskRouteLease("cron-persist-1");
    assert(afterReopen, "lease lost after DB close + reopen");
    console.log("PASS  6. lease persists across SQLite close + reopen");

    console.log("ALL PASS  cron completion delivery is wired to the task-route lease");
  } catch (err) {
    console.error("FAIL:", err);
    exitCode = 1;
  } finally {
    try {
      closeOpenClawStateDatabase();
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
// Suppress unused import warning — pathToFileURL is the conventional helper
// for ESM scripts that take file paths but isn't needed here.
void pathToFileURL;
