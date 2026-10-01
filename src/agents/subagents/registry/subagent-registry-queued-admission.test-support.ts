import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  getGatewaySuspendAdmissionPhase,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import {
  activateSwarmRun,
  closeSwarmScheduler,
  isSwarmRunActive,
  reserveSwarmRun,
} from "../swarm/swarm-scheduler.js";
import type { registerQueuedRegistrationClaimCases } from "./subagent-registry-queued-registration-claims.test-support.js";

export function registerQueuedRegistrationAdmissionCases(
  params: Parameters<typeof registerQueuedRegistrationClaimCases>[0],
) {
  const { fixture } = params;
  it("closes the composed queued collector under suspension after its parent releases", async () => {
    const { createCollectorLaunchCallbacks } = await import("../spawn/subagent-spawn-collector.js");
    const f = fixture();
    const groupId = "composed-suspended-collector";
    const lifecycleOwner = {};
    expect(
      reserveSwarmRun({ groupId, runId: f.registration.runId, maxConcurrent: 1, activeRunIds: [] }),
    ).toBe(true);
    const registration = f.register();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.writes[1]!.gate.resolve();
    await registration;
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
    const parent = tryBeginGatewayRootWorkAdmission("composed-original-parent");
    if (!parent) {
      throw new Error("missing original parent admission");
    }
    const activate = await parent.run(async () =>
      AsyncLocalStorage.bind(() => {
        activateSwarmRun({ groupId, runId: entry.runId, lifecycleOwner, ...callbacks });
      }),
    );
    parent.release();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    if (!suspension) {
      throw new Error("missing reversible suspension");
    }
    expect(suspension.commit()).toBe(true);
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      activate();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(isSwarmRunActive(entry.runId)).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(launch).not.toHaveBeenCalled();
      closing = closeSwarmScheduler(lifecycleOwner).then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      expect(disposalSignal).toBeDefined();
      expect(disposalSignal?.aborted).toBe(false);
      expect(closed).toBe(false);
      expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
      disposal.resolve();
      await closing;
      expect(closed).toBe(true);
      expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
      expect(entry).toEqual(registeredSnapshot);
      expect(settle).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(rollback).not.toHaveBeenCalled();
      expect(f.writes).toHaveLength(2);
      expect(f.options.persistOrThrow).not.toHaveBeenCalled();
      expect(suspension.release()).toBe(true);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(launch).not.toHaveBeenCalled();
      expect(isSwarmRunActive(entry.runId)).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      suspension.release();
      parent.release();
      disposal.resolve();
      await closing;
      await closeSwarmScheduler(lifecycleOwner);
    }
  });
}
