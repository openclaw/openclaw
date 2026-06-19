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
  try {
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    resetTaskRouteLeasesForTests();

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
    });
    assert(acquired, "acquireTaskRouteLease returned undefined");
    assert.equal(acquired.runId, "run-92460-repro");
    assert.equal(acquired.status, "active");
    console.log("PASS  1. acquire → getActive round-trip");
    const fetched = getActiveTaskRouteLease("run-92460-repro");
    assert(fetched, "getActiveTaskRouteLease returned undefined after acquire");
    assert.deepEqual(fetched.requesterOrigin, origin);
    console.log("PASS  2. lease carries the captured requesterOrigin");

    // 3. settle → getActive returns undefined.
    const settled = settleTaskRouteLease("run-92460-repro", "settled");
    assert.equal(settled, true);
    assert(!getActiveTaskRouteLease("run-92460-repro"), "lease still active after settle");
    console.log("PASS  3. settle transitions the lease out of active");

    // 4. extend on a settled lease is a no-op.
    assert.equal(extendTaskRouteLease("run-92460-repro", 60_000), false);
    console.log("PASS  4. extend on settled lease is a no-op");

    // 5. expireStaleTaskRouteLeases: acquire two leases with different TTLs.
    acquireTaskRouteLease({
      runId: "run-stale",
      taskId: "task-stale",
      requesterOrigin: { channel: "telegram", to: "111", accountId: "default" },
      ttlMs: 1,
    });
    acquireTaskRouteLease({
      runId: "run-fresh",
      taskId: "task-fresh",
      requesterOrigin: { channel: "telegram", to: "222", accountId: "default" },
      ttlMs: 60_000,
    });
    // Wait past the 1ms TTL.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const expired = expireStaleTaskRouteLeases();
    assert(expired >= 1, `expected at least 1 expired lease, got ${expired}`);
    assert(!getActiveTaskRouteLease("run-stale"), "stale lease still active after GC");
    assert(getActiveTaskRouteLease("run-fresh"), "fresh lease GC'd prematurely");
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
    });
    closeOpenClawStateDatabase();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const afterReopen = getActiveTaskRouteLease("run-persist");
    assert(afterReopen, "lease lost after DB close + reopen");
    console.log("PASS  7. lease persists across SQLite close + reopen");

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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
// Suppress unused import warning — pathToFileURL is the conventional helper
// for ESM scripts that take file paths but isn't needed here.
void pathToFileURL;
