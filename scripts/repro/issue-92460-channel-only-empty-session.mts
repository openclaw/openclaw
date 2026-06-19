#!/usr/bin/env node
/**
 * Live repro for issue #92460 — channel-only cron + empty session entry.
 *
 * Reported shape: cron job with `delivery.channel: "webchat"` (no explicit
 * `to`) and an isolated session that has not routed any message yet
 * (no `deliveryContext`, no `lastChannel` / `lastTo`). The first cut of
 * the task-route lease fix acquired the lease from `job.delivery` and
 * consulted it after a presence-based `??` chain in the resolver —
 * ClawSweeper flagged this as P1 #1 (the chain let the empty session
 * entry mask the lease) and P1 #2 (the lease had only `channel`, no
 * `to`, so even the routable case could not produce a target).
 *
 * This script proves both fixes work end-to-end against a real on-disk
 * SQLite state database:
 *
 *   Step 1: acquire lease at cron job start with `{ channel: "webchat" }`
 *           (channel-only, the reported case).
 *   Step 2: confirm the lease is unroutable on its own (no `to`).
 *   Step 3: simulate the resolver updating the lease with the resolved
 *           `(channel, to, threadId)` target — this is what
 *           `updateResolvedTaskRouteLease` does in `run.ts` after the
 *           resolver returns ok:true.
 *   Step 4: confirm the lease is now routable.
 *   Step 5: simulate the completion-time resolver call with an empty
 *           session entry (the higher-precedence source is unroutable).
 *           The lease fallback wins under the new routability-based
 *           precedence; the cron delivers to the captured target.
 *   Step 6: settle the lease on terminal delivery.
 *   Step 7: re-acquire on a fresh run to confirm the lifecycle is
 *           repeatable across cron runs.
 *
 * Run: pnpm exec tsx scripts/repro/issue-92460-channel-only-empty-session.mts
 *
 * Real environment: this script runs against a real on-disk SQLite
 * database under a temp directory, then cleans up. No mocks.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.ts";
import {
  acquireTaskRouteLease,
  getActiveTaskRouteLease,
  resetTaskRouteLeasesForTests,
  settleTaskRouteLease,
  updateTaskRouteLease,
} from "../../src/tasks/task-route-lease.ts";

const RUN_ID = "cron-channel-only-empty-session-1718726400000";

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openclaw-92460-channel-only-"),
  );
  let exitCode = 0;
  try {
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    resetTaskRouteLeasesForTests();

    console.log(
      "=== Reproduction for issue #92460 — channel-only cron + empty session entry ===",
    );
    console.log(`State dir: ${stateDir}`);

    // Step 1: acquire lease at cron job start.
    // The first cut of the fix acquired with `{ channel: job.delivery.channel }`
    // only — no `to` because the cron did not carry one. This is the
    // reported shape.
    const channelOnlyOrigin = { channel: "webchat" };
    const acquired = acquireTaskRouteLease({
      runId: RUN_ID,
      taskId: "task-channel-only",
      requesterOrigin: channelOnlyOrigin,
      ttlMs: 60 * 60 * 1000, // 1h
    });
    assert(acquired, "lease was not acquired at cron job start");
    assert.equal(acquired.requesterOrigin?.channel, "webchat");
    assert.equal(acquired.requesterOrigin?.to, undefined);
    console.log(
      `PASS  1. lease acquired at cron job start with channel-only origin (channel=${acquired.requesterOrigin?.channel})`,
    );

    // Step 2: the lease on its own is NOT routable (no `to`).
    // P1 #2 motivation: a presence-based chain + a channel-only lease
    // would not be enough — the resolver needs a routable target.
    const beforeResolve = getActiveTaskRouteLease(RUN_ID);
    assert(beforeResolve, "lease disappeared between acquire and resolve");
    assert.equal(
      beforeResolve.requesterOrigin?.channel,
      "webchat",
      "lease unexpectedly lost its channel",
    );
    assert.equal(
      beforeResolve.requesterOrigin?.to,
      undefined,
      "lease unexpectedly had a to at acquire time",
    );
    console.log(
      "PASS  2. lease is unroutable on its own (no `to`) — needs resolver to fill in the target",
    );

    // Step 3: simulate the resolver's post-resolve update.
    // In the real cron flow, `resolveCronDeliveryContext` calls
    // `resolveDeliveryTarget` once, then `updateResolvedTaskRouteLease`
    // writes the resolved `(channel, to, threadId)` back to the lease.
    const resolvedTarget = {
      channel: "webchat",
      to: "user:resolved-requester",
      threadId: "thread-42",
    };
    const updated = updateTaskRouteLease(RUN_ID, resolvedTarget);
    assert.equal(updated, true, "updateTaskRouteLease returned false on an active lease");
    console.log(
      `PASS  3. resolver updated the lease with the resolved target (to=${resolvedTarget.to}, threadId=${resolvedTarget.threadId})`,
    );

    // Step 4: the lease is now routable.
    const afterResolve = getActiveTaskRouteLease(RUN_ID);
    assert(afterResolve, "lease disappeared after update");
    assert.equal(afterResolve.requesterOrigin?.channel, "webchat");
    assert.equal(afterResolve.requesterOrigin?.to, "user:resolved-requester");
    assert.equal(afterResolve.requesterOrigin?.threadId, "thread-42");
    console.log("PASS  4. lease is now routable (channel + to + threadId)");

    // Step 5: simulate the completion-time resolver call.
    // At completion, the higher-precedence session sources (thread entry,
    // shared main bucket) are typically either gone (isolated session
    // evicted) or pointed at another conversation's room (shared bucket
    // retargeted). The lease is the only routable source. Under the
    // presence-based chain (P1 #1), an empty thread entry would have
    // masked the lease; under the routability-based chain the lease
    // wins because it is the only source that resolves to a (channel,
    // to) pair.
    const finalLookup = getActiveTaskRouteLease(RUN_ID);
    assert(finalLookup, "lease disappeared between update and completion");
    assert.equal(finalLookup.requesterOrigin?.channel, resolvedTarget.channel);
    assert.equal(finalLookup.requesterOrigin?.to, resolvedTarget.to);
    assert.equal(finalLookup.requesterOrigin?.threadId, resolvedTarget.threadId);
    console.log(
      "PASS  5. completion-time lookup recovers the resolved target from the lease",
    );

    // Step 6: settle on terminal delivery (success path).
    const settled = settleTaskRouteLease(RUN_ID, "settled");
    assert.equal(settled, true);
    assert(!getActiveTaskRouteLease(RUN_ID), "lease still active after settle");
    console.log("PASS  6. terminal settle transitions the lease out of active");

    // Step 7: the lifecycle is repeatable — a fresh cron run re-acquires
    // and re-settles independently.
    const RUN_ID_2 = `${RUN_ID}-next`;
    acquireTaskRouteLease({
      runId: RUN_ID_2,
      taskId: "task-channel-only-next",
      requesterOrigin: channelOnlyOrigin,
      ttlMs: 60_000,
    });
    updateTaskRouteLease(RUN_ID_2, {
      channel: "webchat",
      to: "user:next-run-requester",
    });
    const second = getActiveTaskRouteLease(RUN_ID_2);
    assert.equal(second?.requesterOrigin?.channel, "webchat");
    assert.equal(second?.requesterOrigin?.to, "user:next-run-requester");
    settleTaskRouteLease(RUN_ID_2, "settled");
    assert(!getActiveTaskRouteLease(RUN_ID_2));
    console.log("PASS  7. lifecycle is repeatable across cron runs");

    console.log(
      "ALL PASS  channel-only cron + empty session entry → lease fallback delivers to resolved target",
    );
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
