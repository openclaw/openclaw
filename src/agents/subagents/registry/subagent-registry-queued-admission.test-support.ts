import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as admission from "../../../process/gateway-work-admission.js";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import * as swarm from "../swarm/swarm-scheduler.js";
import { withQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";

export function registerQueuedRegistrationAdmissionCases() {
  it("closes the composed queued collector under suspension after its parent releases", async () => {
    const { createCollectorLaunchCallbacks } = await import("../spawn/subagent-spawn-collector.js");
    await withQueuedRegistrationFixture(async (f) => {
      const groupId = "composed-suspended-collector";
      const lifecycleOwner = {};
      expect(
        swarm.reserveSwarmRun({
          groupId,
          runId: f.registration.runId,
          maxConcurrent: 1,
          activeRunIds: [],
        }),
      ).toBe(true);
      await f.register();
      const entry = f.runs.get(f.registration.runId)!;
      const registeredSnapshot = structuredClone(entry);
      const settle = vi.spyOn(f.manager, "settleFailedQueuedSubagentLaunch");
      const launch = vi.fn(async () => {
        throw new Error("removed collector dispatched");
      });
      const cleanup = vi.fn(async () => ({ attachmentsRemoved: false, sessionDeleted: false }));
      const rollback = vi.fn(async () => {});
      const disposal = createDeferred();
      let disposalSignal: AbortSignal | undefined;
      const dispose = vi.fn(async () => {
        disposalSignal = getAsyncWorkSignal();
        await disposal.promise;
      });
      const callbacks = createCollectorLaunchCallbacks({
        childRunId: entry.runId,
        childSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        registrationScope: f.scope,
        preparation: { rollback, dispose },
        provisionalSessionIdentity: {},
        launchChildRun: launch,
        recordParticipant: vi.fn(),
        emitSpawnLifecycleHooks: async () => {},
        cleanupFailedSpawn: cleanup,
      });
      const parent = admission.tryBeginGatewayRootWorkAdmission("composed-original-parent");
      assert(parent, "missing original parent admission");
      const activate = await parent.run(async () =>
        AsyncLocalStorage.bind(() => {
          swarm.activateSwarmRun({ groupId, runId: entry.runId, lifecycleOwner, ...callbacks });
        }),
      );
      parent.release();
      const suspension = admission.tryBeginGatewaySuspendAdmission(() => {});
      assert(suspension, "missing reversible suspension");
      expect(suspension.commit()).toBe(true);
      let closed = false;
      let closing: Promise<void> | undefined;
      const state = () => ({
        active: swarm.isSwarmRunActive(entry.runId),
        roots: admission.getActiveGatewayRootWorkCount(),
        phase: admission.getGatewaySuspendAdmissionPhase(),
        closed,
        aborted: disposalSignal?.aborted,
      });
      try {
        activate();
        await nextTurn();
        expect(state()).toMatchObject({ active: true, roots: 0 });
        expect(launch).not.toHaveBeenCalled();
        closing = swarm.closeSwarmScheduler(lifecycleOwner).then(() => {
          closed = true;
        });
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
        expect(state()).toMatchObject({ aborted: false, closed: false, phase: "prepared" });
        disposal.resolve();
        await closing;
        expect(state()).toMatchObject({ closed: true, phase: "prepared" });
        expect(entry).toEqual(registeredSnapshot);
        expect(settle).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
        expect(f.writes).toBe(1);
        expect(suspension.release()).toBe(true);
        await nextTurn();
        expect(launch).not.toHaveBeenCalled();
        expect(state()).toMatchObject({ active: false, roots: 0 });
      } finally {
        suspension.release();
        parent.release();
        disposal.resolve();
        await closing;
        await swarm.closeSwarmScheduler(lifecycleOwner);
      }
    });
  });
}
