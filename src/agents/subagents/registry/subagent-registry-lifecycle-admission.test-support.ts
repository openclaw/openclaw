import { expect, it, vi } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import * as admission from "../../../state/agent-database-admission.js";
import * as lifecycle from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { RequesterSettleWakeState } from "./subagent-registry.types.js";

const database = { agentId: "main", paths: ["/synthetic/db"], reason: "inspection" };
const inspectionError = (pending = false) =>
  new admission.AgentDatabaseAdmissionError(
    admission.createAgentDatabaseInspectionRefusal({ ...database, pending }),
  );

export function registerRequesterDatabaseAdmissionTests({
  createLifecycleController,
  waitForLifecycleState,
}: Pick<lifecycle.LifecycleTestDrivers, "createLifecycleController" | "waitForLifecycleState">) {
  function fixture(requesterSettleWake?: RequesterSettleWakeState) {
    const entry = lifecycle.createRunEntry({ endedAt: 4_000, requesterSettleWake });
    const warn = vi.fn();
    const settleWake =
      vi.fn<SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]>();
    const controller = createLifecycleController({
      entry,
      warn,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });
    const read = () => lifecycle.readLifecycleRun(entry);
    const resume = async () => {
      const join = observeRootWork();
      controller.resumeRequesterSettleWake(entry.runId, read());
      await join();
    };
    return { entry, controller, warn, settleWake, read, resume };
  }

  it.each(["ready", "cancelled"])(
    "retains a wake through pending database inspection until %s",
    async (outcome) => {
      const wake: RequesterSettleWakeState = {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds: ["run-1"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };
      const { controller, settleWake, read, resume } = fixture(wake);
      const pending = inspectionError(true);
      let ready = false;
      settleWake.mockImplementation(async ({ completeBatch, settledEntry }) => {
        if (!ready) {
          throw pending;
        }
        await completeBatch([settledEntry], wake.rearmGeneration, {
          delivered: true,
          path: "direct",
        });
        return true;
      });
      await resume();
      expect(read().requesterSettleWake).toEqual(wake);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(settleWake).toHaveBeenCalledOnce();
      ready = outcome === "ready";
      if (!ready) {
        await controller.retireSubagentObligations(read(), () => {}, { requesterNotified: true });
      }
      await resume();
      expect(settleWake).toHaveBeenCalledTimes(outcome === "cancelled" ? 1 : 2);
      expect(read().requesterSettleWake).toBeUndefined();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it.each(["ordinary", "inspection-failed"])(
    "settles bookkeeping after a %s wake rejection before attempt admission",
    async (kind) => {
      const { entry, controller, warn, settleWake, read } = fixture();
      settleWake.mockImplementation(async () => {
        throw kind === "inspection-failed" ? inspectionError() : new Error("wake exploded");
      });
      await expect(
        controller.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          cleanup: "keep",
          completedAt: 5_000,
        }),
      ).resolves.toBeUndefined();
      await waitForLifecycleState(() => {
        expect(warn).toHaveBeenCalledWith("requester settle wake failed", expect.anything());
        expect(read().requesterSettleWake).toBeUndefined();
      });
    },
  );
}
