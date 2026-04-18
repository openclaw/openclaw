// Regression: sweeper must not self-stop while pendingLifecycleErrorByRunId
// still has entries.
//
// Bug: the sweep cycle ends with
//   if (subagentRuns.size === 0) { stopSweeper(); }
// without also checking the pending-error map that the SAME sweep cycle is
// responsible for expiring via PENDING_ERROR_TTL_MS. Any entry newer than
// PENDING_ERROR_TTL_MS (5 min) at the self-stop moment is stranded until a
// subsequent registerSubagentRun call revives the sweeper, which on an idle
// workload can be hours to days. The entry holds a NodeJS.Timeout and the
// cached error payload the entire time.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, resetSubagentRegistryForTests } from "./subagent-registry.js";

describe("sweeper self-stop respects pendingLifecycleErrorByRunId", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  it("keeps sweeper running while pending lifecycle errors exist", async () => {
    // Populate pending-error map with an entry that has not yet reached its
    // PENDING_ERROR_TTL_MS. subagentRuns stays empty — the exact condition
    // that trips the buggy self-stop.
    __testing.schedulePendingLifecycleErrorForTest({
      runId: "sweeper-drain-regression",
      endedAt: Date.now(),
      error: "regression fixture",
    });
    expect(__testing.getPendingLifecycleErrorCountForTest()).toBe(1);
    expect(__testing.getSubagentRunsSizeForTest()).toBe(0);

    __testing.startSweeperForTest();
    expect(__testing.isSweeperActiveForTest()).toBe(true);

    // Run one sweep cycle. Pending TTL is not yet reached, so the cycle leaves
    // the entry in the map. The self-stop check must observe that the map is
    // non-empty and keep the sweeper alive so a later cycle can expire it.
    await __testing.runSweepForTest();

    expect(__testing.getPendingLifecycleErrorCountForTest()).toBe(1);
    expect(__testing.isSweeperActiveForTest()).toBe(true);
  });
});
