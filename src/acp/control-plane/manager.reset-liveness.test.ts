/** Reset overlap must preserve the successor task through the real maintenance decision. */
import { afterEach, describe, expect, it } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { isAcpTurnActive } from "./active-turns.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
} from "./manager.test-helpers.js";
import { resolveAcpSessionTarget } from "./manager.utils.js";

afterEach(async () => {
  const maintenance = await import("../../tasks/task-registry.maintenance.js");
  maintenance.stopTaskRegistryMaintenance();
  maintenance.resetTaskRegistryMaintenanceRuntimeForTests();
});

describe("ACP reset successor task liveness", () => {
  installAcpSessionManagerTestLifecycle();

  it("retains a silent successor through maintenance after the retired predecessor settles", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const { runTaskRegistryMaintenance } =
        await import("../../tasks/task-registry.maintenance.js");
      const { createTaskRegistryMaintenanceHarness } =
        await import("../../tasks/task-registry.maintenance.test-support.js");
      const sessionKey = "agent:codex:acp:reset-liveness";
      const runtimeState = createRuntime();
      const oldEntered = createDeferred();
      const freshEntered = createDeferred();
      const releaseOld = createDeferred();
      const releaseFresh = createDeferred();
      let ensureCount = 0;
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${++ensureCount}`,
      }));
      runtimeState.runTurn.mockImplementation(async function* (input) {
        if (input.text === "old turn") {
          oldEntered.resolve();
          await releaseOld.promise;
        } else {
          freshEntered.resolve();
          await releaseFresh.promise;
        }
        yield { type: "done" as const };
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: sessionKey,
        parentSessionKey: "agent:quant:telegram:quant:direct:822430204",
      });
      const manager = new AcpSessionManager();
      const input = {
        provenance: "system" as const,
        cfg: baseCfg,
        sessionKey,
        mode: "prompt" as const,
      };
      const old = manager.runTurn({ ...input, text: "old turn", requestId: "retired-turn" });
      const oldSettled = old.catch(() => undefined);
      let fresh: Promise<void> | undefined;
      try {
        await Promise.race([
          oldEntered.promise,
          old.then(() => {
            throw new Error("Predecessor completed before entering the controlled runtime");
          }),
        ]);
        await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
          cfg: baseCfg,
          sessionKey,
          reason: "session-reset",
        });
        fresh = manager.runTurn({ ...input, text: "fresh turn", requestId: "successor-turn" });
        await Promise.race([
          freshEntered.promise,
          fresh.then(() => {
            throw new Error("Successor completed before entering the controlled runtime");
          }),
        ]);
        expect(ensureCount).toBe(2);
        const successor = requireTaskByRunId("successor-turn");
        expect(successor.status).toBe("running");
        const staleAt = Date.now() - 10 * 60_000;
        const { currentTasks } = createTaskRegistryMaintenanceHarness({
          tasks: [{ ...successor, createdAt: staleAt, startedAt: staleAt, lastEventAt: staleAt }],
          hasActiveAcpTurn: (key, agentId) =>
            isAcpTurnActive(resolveAcpSessionTarget({ cfg: baseCfg, sessionKey: key, agentId })),
        });
        releaseOld.resolve();
        await oldSettled;
        const maintenance = await runTaskRegistryMaintenance();
        expect(currentTasks.get(successor.taskId)?.status).toBe("running");
        expect(maintenance.reconciled).toBe(0);
        expect(isAcpTurnActive({ sessionKey, agentId: "codex" })).toBe(true);
        releaseFresh.resolve();
        await fresh;
        expect(isAcpTurnActive({ sessionKey, agentId: "codex" })).toBe(false);
      } finally {
        releaseOld.resolve();
        releaseFresh.resolve();
        await Promise.allSettled([oldSettled, ...(fresh ? [fresh] : [])]);
      }
    });
  });
});
