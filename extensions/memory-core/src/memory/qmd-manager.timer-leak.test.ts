import { describe, expect, it } from "vitest";
import { QmdMemoryManager } from "./qmd-manager.js";

/**
 * Real-timer regression guard for the pending-update wait timer leak.
 *
 * Uses Node's real timer scheduler and `process.getActiveResourcesInfo()` to count
 * actual pending "Timeout" handles, mirroring the uncommitted exact-head proof script
 * (no fake timers, no mock assertions). Reverting the `clearTimeout` in
 * `waitForPendingUpdateBeforeSearch` makes this test fail with a positive delta.
 */
describe("QmdMemoryManager.waitForPendingUpdateBeforeSearch timer cleanup", () => {
  it("clears the wait timeout when the pending update settles first", async () => {
    // Real instance carrying the real prototype method. The method reads only
    // this.pendingUpdate, so the instance is otherwise uninitialized; the full
    // create() factory spawns the external qmd process, which is out of scope here.
    const mgr = Object.create(QmdMemoryManager.prototype) as {
      pendingUpdate: Promise<void> | null;
      waitForPendingUpdateBeforeSearch: () => Promise<void>;
    };

    function countPendingTimeouts(): number {
      return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    }

    // Let any ambient timers settle before taking the baseline.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const baseline = countPendingTimeouts();

    const iterations = 20;
    for (let index = 0; index < iterations; index += 1) {
      // pendingUpdate already resolved: reindex completed in under 500ms (the common
      // case). The method races it against setTimeout(resolve, 500); when pending
      // wins, that timeout must be cleared instead of left pending.
      mgr.pendingUpdate = Promise.resolve();
      await mgr.waitForPendingUpdateBeforeSearch();
    }

    // The race settles on a microtask; let it drain before measuring. This is far
    // faster than the 500ms wait timeout, so any leaked timer would still be pending.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const after = countPendingTimeouts();

    expect(after - baseline).toBe(0);
  });
});
