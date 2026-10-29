import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  createArchivedSubagentSweeperRun as archivedRun,
  createSubagentSweeperHarness as createHarness,
} from "./subagent-registry-sweeper.test-support.js";

export function registerSubagentSweepShutdownTests() {
  it.each([false, true])(
    "finishes admitted cleanup and defers the remaining sweep during shutdown (collector=%s)",
    async (collector) => {
      const retained = collector
        ? { collect: true, groupId: "group", collectorCompletion: { status: "done" as const } }
        : {};
      const { entry, runs, callGateway, sweeper } = createHarness({}, archivedRun(retained));
      const sibling = archivedRun({
        ...retained,
        runId: "sibling-run",
        childSessionKey: "agent:main:subagent:sibling",
      });
      runs.set(sibling.runId, sibling);
      const entered = createDeferred();
      const release = createDeferred();
      callGateway.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      let settled = false;
      const sweep = sweeper.runTick().then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        markGatewayRestartDraining("stop (SIGTERM)");
        expect(settled).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      } finally {
        release.resolve();
        await sweep;
      }
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect([...runs.keys()]).toEqual(collector ? [entry.runId, sibling.runId] : [sibling.runId]);
      resetGatewayWorkAdmission();
      await sweeper.runTick();
      expect(runs.size).toBe(0);
      expect(callGateway).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ key: sibling.childSessionKey }),
        }),
      );
    },
  );

  it("does not admit a retention sweep after shutdown begins", async () => {
    const { entry, runs, callGateway, sweeper } = createHarness({}, archivedRun());
    markGatewayRestartDraining("stop (SIGTERM)");
    await sweeper.runTick();
    expect(callGateway).not.toHaveBeenCalled();
    expect(runs.get(entry.runId)).toBe(entry);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    resetGatewayWorkAdmission();
    await sweeper.runTick();
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runs.size).toBe(0);
  });
}
