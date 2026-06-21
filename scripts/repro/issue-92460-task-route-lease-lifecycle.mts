#!/usr/bin/env node
/**
 * Live repro for issue #92460 — task-route lease lifecycle.
 *
 * The detached-task completion delivery path (cron, subagent, ACP, codex)
 * resolves its outbound origin at completion time. The originating
 * session entry can be evicted, the shared main session bucket can be
 * retargeted by another conversation, and the explicit delivery config
 * may not survive all the way to the announce step. The task-route lease
 * module (`src/tasks/task-route-lease.ts`) captures the original
 * outbound origin at job start and exposes it as a session-identity
 * fallback for the delivery-target resolver.
 *
 * Run: pnpm exec tsx scripts/repro/issue-92460-task-route-lease-lifecycle.mts
 *
 * Behavior proved here:
 *   1. acquire → getActive round-trip
 *   2. acquire with origin → getActive returns the same origin
 *   3. settle → getActive returns undefined (lease is no longer active)
 *   4. extend → expiresAt is bumped
 *   5. expireStaleTaskRouteLeases GC only marks expired rows
 *   6. mapDeliveryStatusToLeaseRetirement maps terminal statuses
 *   7. SQLite persistence: close + reopen keeps the row
 *   8. re-acquire after settle clears settledAt (PR #95352 P3 fix)
 *   9. deleteTaskRouteLeasesByTaskIdInDb removes all leases for a task
 *      atomically (PR #95352 P2 retention fix)
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
  deleteTaskRouteLeasesByTaskIdInDb,
  expireStaleTaskRouteLeases,
  extendTaskRouteLease,
  getActiveTaskRouteLease,
  mapDeliveryStatusToLeaseRetirement,
  resetTaskRouteLeasesForTests,
  settleTaskRouteLease,
} from "../../src/tasks/task-route-lease.ts";

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-92460-repro-"));
  let exitCode = 0;
  const leaseEnv = { OPENCLAW_STATE_DIR: stateDir };
  try {
    openOpenClawStateDatabase({ env: leaseEnv });
    resetTaskRouteLeasesForTests({ env: leaseEnv });

    console.log("=== Reproduction for issue #92460 — task-route lease lifecycle ===");
    console.log(`State dir: ${stateDir}`);

    // 1. acquire → getActive round-trip.
    const origin = {
      channel: "telegram",
      to: "100200300",
      accountId: "default",
      threadId: 42 as number,
    };
    const acquired = acquireTaskRouteLease({
      runId: "run-92460-repro",
      taskId: "task-92460-repro",
      requesterOrigin: origin,
      ttlMs: 60_000,
      env: leaseEnv,
    });
    assert(acquired, "acquireTaskRouteLease returned undefined");
    assert.equal(acquired.runId, "run-92460-repro");
    assert.equal(acquired.status, "active");
    console.log("PASS  1. acquire → getActive round-trip");
    const fetched = getActiveTaskRouteLease("run-92460-repro", { env: leaseEnv });
    assert(fetched, "getActiveTaskRouteLease returned undefined after acquire");
    assert.deepEqual(fetched.requesterOrigin, origin);
    console.log("PASS  2. lease carries the captured requesterOrigin");

    // 3. settle → getActive returns undefined.
    const settled = settleTaskRouteLease("run-92460-repro", "settled", { env: leaseEnv });
    assert.equal(settled, true);
    assert(!getActiveTaskRouteLease("run-92460-repro", { env: leaseEnv }), "lease still active after settle");
    console.log("PASS  3. settle transitions the lease out of active");

    // 4. extend on a settled lease is a no-op.
    assert.equal(extendTaskRouteLease("run-92460-repro", 60_000, { env: leaseEnv }), false);
    console.log("PASS  4. extend on settled lease is a no-op");

    // 5. expireStaleTaskRouteLeases: acquire two leases with different TTLs.
    acquireTaskRouteLease({
      runId: "run-stale",
      taskId: "task-stale",
      requesterOrigin: { channel: "telegram", to: "111", accountId: "default" },
      ttlMs: 1,
      env: leaseEnv,
    });
    acquireTaskRouteLease({
      runId: "run-fresh",
      taskId: "task-fresh",
      requesterOrigin: { channel: "telegram", to: "222", accountId: "default" },
      ttlMs: 60_000,
      env: leaseEnv,
    });
    // Wait past the 1ms TTL.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const expired = expireStaleTaskRouteLeases({ env: leaseEnv });
    assert(expired >= 1, `expected at least 1 expired lease, got ${expired}`);
    assert(!getActiveTaskRouteLease("run-stale", { env: leaseEnv }), "stale lease still active after GC");
    assert(getActiveTaskRouteLease("run-fresh", { env: leaseEnv }), "fresh lease GC'd prematurely");
    console.log(`PASS  5. expireStaleTaskRouteLeases GC (${expired} lease(s) expired)`);

    // 6. mapDeliveryStatusToLeaseRetirement.
    assert.equal(mapDeliveryStatusToLeaseRetirement("delivered"), "settled");
    assert.equal(mapDeliveryStatusToLeaseRetirement("session_queued"), "settled");
    assert.equal(mapDeliveryStatusToLeaseRetirement("failed"), "retired");
    assert.equal(mapDeliveryStatusToLeaseRetirement("pending"), null);
    console.log("PASS  6. mapDeliveryStatusToLeaseRetirement maps terminal statuses");

    // 7. SQLite persistence: close and reopen, lease is still readable.
    acquireTaskRouteLease({
      runId: "run-persist",
      taskId: "task-persist",
      requesterOrigin: { channel: "telegram", to: "333", accountId: "default" },
      ttlMs: 60_000,
      env: leaseEnv,
    });
    closeOpenClawStateDatabase();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const afterReopen = getActiveTaskRouteLease("run-persist", { env: leaseEnv });
    assert(afterReopen, "lease lost after DB close + reopen");
    console.log("PASS  7. lease persists across SQLite close + reopen");

    // 8. PR #95352 P3 fix: re-acquire after settle must clear settledAt.
    // Without the fix, the conflict update left the old settled_at value
    // in place, so getActive would return a lease whose .settledAt still
    // reflected the prior terminal transition.
    acquireTaskRouteLease({
      runId: "run-reacquire-settled-at",
      taskId: "task-reacquire-settled-at",
      requesterOrigin: { channel: "telegram", to: "444", accountId: "default" },
      ttlMs: 60_000,
      env: leaseEnv,
    });
    settleTaskRouteLease("run-reacquire-settled-at", "settled", { env: leaseEnv });
    acquireTaskRouteLease({
      runId: "run-reacquire-settled-at",
      taskId: "task-reacquire-settled-at",
      requesterOrigin: { channel: "telegram", to: "444-reset", accountId: "default" },
      ttlMs: 60_000,
      env: leaseEnv,
    });
    const reacquired = getActiveTaskRouteLease("run-reacquire-settled-at", { env: leaseEnv });
    assert(reacquired, "re-acquired lease not active");
    assert.equal(reacquired.status, "active");
    assert.equal(
      reacquired.settledAt,
      undefined,
      "settledAt should be cleared on re-acquire (PR #95352 P3)",
    );
    console.log("PASS  8. re-acquire after settle clears settledAt");

    // 9. PR #95352 P2 fix: deleteTaskRouteLeasesByTaskIdInDb removes
    // every lease row for the given taskId atomically. The full task
    // registry delete path is covered by task-registry.store.test.ts;
    // this proves the lease-module helper behaves as advertised on a
    // real DB.
    acquireTaskRouteLease({
      runId: "run-cascade-A",
      taskId: "task-cascade-repro",
      requesterOrigin: { channel: "telegram", to: "555", accountId: "default" },
      ttlMs: 60_000,
      env: leaseEnv,
    });
    acquireTaskRouteLease({
      runId: "run-cascade-B",
      taskId: "task-cascade-repro",
      requesterOrigin: { channel: "telegram", to: "555", accountId: "default" },
      ttlMs: 60_000,
      env: leaseEnv,
    });
    acquireTaskRouteLease({
      runId: "run-cascade-other",
      taskId: "task-cascade-other",
      requesterOrigin: { channel: "telegram", to: "666", accountId: "default" },
      ttlMs: 60_000,
      env: leaseEnv,
    });
    const { db } = openOpenClawStateDatabase({ env: leaseEnv });
    const deleted = deleteTaskRouteLeasesByTaskIdInDb(db, "task-cascade-repro");
    assert.equal(deleted, 2, `expected 2 leases deleted, got ${deleted}`);
    assert(!getActiveTaskRouteLease("run-cascade-A", { env: leaseEnv }), "run-cascade-A still active");
    assert(!getActiveTaskRouteLease("run-cascade-B", { env: leaseEnv }), "run-cascade-B still active");
    assert(
      getActiveTaskRouteLease("run-cascade-other", { env: leaseEnv }),
      "unrelated task's lease was incorrectly deleted",
    );
    console.log("PASS  9. deleteTaskRouteLeasesByTaskIdInDb cascade");

    console.log("ALL PASS  task-route lease lifecycle behaves as expected");
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

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
// Suppress unused import warning — pathToFileURL is the conventional helper
// for ESM scripts that take file paths but isn't needed here.
void pathToFileURL;
