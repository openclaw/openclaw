import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { markGatewayRestartDraining } from "../../../process/gateway-work-admission.js";
import { runSpawnPipeline, summarizeSpawnError } from "../../spawn-pipeline.js";
import {
  activateSwarmRun,
  closeSwarmScheduler,
  isSwarmRunActive,
  reserveSwarmRun,
} from "../swarm/swarm-scheduler.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { createQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerQueuedRegistrationClaimCases(params: {
  fixture: () => ReturnType<typeof createQueuedRegistrationFixture>;
}) {
  const { fixture } = params;
  it.each(
    (["complete", "incomplete", "rejected"] as const).flatMap((cleanupResult) => [
      { cleanupResult, failure: new Error("original transport failure"), failureKind: "Error" },
      { cleanupResult, failure: null, failureKind: "falsy" },
    ]),
  )(
    "retries only settlement after $cleanupResult cleanup and a $failureKind launch failure",
    async ({ cleanupResult, failure }) => {
      const { createCollectorLaunchCallbacks } =
        await import("../spawn/subagent-spawn-collector.js");
      const f = fixture();
      const groupId = "settlement-only-retry";
      expect(
        reserveSwarmRun({
          groupId,
          runId: f.registration.runId,
          maxConcurrent: 1,
          activeRunIds: [],
        }),
      ).toBe(true);
      const registration = f.register();
      f.writes[0]!.gate.resolve();
      await vi.waitFor(() => expect(f.writes).toHaveLength(2));
      f.writes[1]!.gate.resolve();
      await registration;
      const entry = f.runs.get(f.registration.runId)!;
      const { completeCollectorLaunchCleanup } = await import("./subagent-registry.js");
      const launch = vi.fn(() => {
        const attempt = createDeferred<never>();
        attempt.reject(failure);
        return attempt.promise;
      });
      const cleanup = vi.fn(async () => {
        if (cleanupResult === "rejected") {
          throw new Error("cleanup acknowledgement unknown");
        }
        return {
          attachmentsRemoved: cleanupResult === "complete",
          sessionDeleted: cleanupResult === "complete",
        };
      });
      const rollback = vi.fn(async () => {});
      const callbacks = createCollectorLaunchCallbacks({
        childRunId: entry.runId,
        childSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        registrationScope: f.scope,
        preparation: { rollback, dispose: async () => {} },
        provisionalSessionIdentity: {},
        launchChildRun: launch,
        recordParticipant: vi.fn(),
        emitSpawnLifecycleHooks: async () => {},
        cleanupFailedSpawn: cleanup,
      });
      const failures = vi.fn(callbacks.onStartFailure);
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        activateSwarmRun({ groupId, runId: entry.runId, ...callbacks, onStartFailure: failures });
        await vi.waitFor(() => expect(f.writes).toHaveLength(3));
        expect(f.writes[2]!.snapshot.get(entry.runId)?.queuedLaunch).toBeUndefined();
        f.writes[2]!.gate.resolve();
        await vi.waitFor(() => expect(f.writes).toHaveLength(4));
        f.writes[3]!.gate.reject(
          new SubagentRegistryWriteError("not-committed", new Error("terminal write refused")),
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(entry.execution.status).toBe("queued");
        expect(f.scope.canLaunch()).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(f.writes).toHaveLength(5));
        expect(f.writes[4]!.snapshot.get(entry.runId)?.execution.status).toBe("terminal");
        f.writes[4]!.gate.resolve();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(f.options.persistOrThrow).not.toHaveBeenCalled();
        expect(failures.mock.calls).toEqual([[failure], [failure]]);
        expect(launch).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(rollback).toHaveBeenCalledOnce();
        expect(entry.execution).toMatchObject({
          status: "terminal",
          outcome: { status: "error", error: summarizeSpawnError(failure) },
        });
        expect(isSwarmRunActive(entry.runId)).toBe(false);
        expect(completeCollectorLaunchCleanup).toHaveBeenCalledTimes(
          cleanupResult === "complete" ? 1 : 0,
        );
      } finally {
        f.acknowledgeAllWrites();
        await closeSwarmScheduler();
        vi.useRealTimers();
      }
    },
  );
  it.each(["initial intent", "descriptor", "recovery intent", "terminal"] as const)(
    "waits for a reacquired claim before continuing %s",
    async (stage) => {
      const f = fixture();
      const registration = f.register();
      const registrationJoined = registration?.catch(() => {});
      if (stage !== "initial intent") {
        f.writes[0]!.gate.resolve();
        await vi.waitFor(() => expect(f.writes).toHaveLength(2));
      }
      const entry = f.runs.get(f.registration.runId)!;
      let completion = registration;
      if (stage === "recovery intent" || stage === "terminal") {
        f.writes[1]!.gate.resolve();
        await registration;
        f.runs.set("successor", {
          ...structuredClone(entry),
          runId: "successor",
          generation: (entry.generation ?? 0) + 1,
        });
        completion = f.scope.settleFailedLaunch("original failure");
        if (stage === "terminal") {
          f.writes[2]!.gate.resolve();
          await vi.waitFor(() => expect(f.writes).toHaveLength(4));
        }
      }
      let completed = false;
      const joined = completion?.then(
        () => {
          completed = true;
        },
        () => {
          completed = true;
        },
      );
      const attemptCount = f.writes.length;
      const writeObservers = [...f.persistenceObservers];
      const first = f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
      if (!first) {
        throw new Error("missing initial claim");
      }
      const observedWait = f.scope.waitForClaim();
      if (!observedWait) {
        throw new Error("missing claim observer");
      }
      let second: SubagentRunRecord["killIntent"];
      const reacquired = observedWait.then(() => {
        second = f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
        expect(second).toBeDefined();
      });
      try {
        f.writes[attemptCount - 1]!.gate.resolve();
        await vi.waitFor(() => {
          expect(writeObservers.every((listener) => !f.persistenceObservers.has(listener))).toBe(
            true,
          );
          expect(f.persistenceObservers.size).toBe(2);
        });
        expect(
          f.manager.releaseSubagentRunKillClaim({
            runId: entry.runId,
            expected: entry,
            claim: first,
          }),
        ).toBe(true);
        await reacquired;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(entry.killIntent).toBe(second);
        expect(completed).toBe(false);
        expect(f.writes).toHaveLength(attemptCount);
      } finally {
        const claim = entry.killIntent;
        if (claim) {
          f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim });
        }
        await reacquired;
        const remaining = entry.killIntent;
        if (remaining) {
          f.manager.releaseSubagentRunKillClaim({
            runId: entry.runId,
            expected: entry,
            claim: remaining,
          });
        }
        f.acknowledgeAllWrites();
        await joined;
        await registrationJoined;
      }
      await expect(completion).resolves.toBeUndefined();
    },
  );
  it.each(
    (["recovery intent", "terminal"] as const).flatMap((stage) =>
      (["unknown", "committed"] as const).map((outcome) => ({ stage, outcome })),
    ),
  )(
    "retains $outcome staged settlement error for $stage after a released claim",
    async ({ stage, outcome }) => {
      const f = fixture();
      const registered = f.register();
      f.writes[0]!.gate.resolve();
      await vi.waitFor(() => expect(f.writes).toHaveLength(2));
      f.writes[1]!.gate.resolve();
      await registered;
      const entry = f.runs.get(f.registration.runId)!;
      f.runs.set("successor", {
        ...structuredClone(entry),
        runId: "successor",
        generation: (entry.generation ?? 0) + 1,
      });
      const settlement = f.scope.settleFailedLaunch("original failure");
      const reported = settlement.catch((error: unknown) => error);
      const attemptIndex = stage === "recovery intent" ? 2 : 3;
      if (stage === "terminal") {
        f.writes[2]!.gate.resolve();
        await vi.waitFor(() => expect(f.writes).toHaveLength(4));
      }
      const claim = f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
      if (!claim) {
        throw new Error("missing no-replay claim");
      }
      expect(
        f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim }),
      ).toBe(true);
      const failure = new SubagentRegistryWriteError(
        outcome,
        new Error("settlement acknowledgement failed"),
      );
      if (outcome === "committed") {
        f.writes[attemptIndex]!.afterPublicationFailure = { error: failure };
        f.writes[attemptIndex]!.gate.resolve();
      } else {
        f.writes[attemptIndex]!.gate.reject(failure);
      }
      const retained = await reported;
      expect(retained).toMatchObject({
        cause: "original failure",
        errors: ["original failure", failure],
      });
      await expect(f.scope.settleFailedLaunch("repeat callback")).rejects.toBe(retained);
      expect(f.writes).toHaveLength(attemptIndex + 1);
      expect(f.scope.canCleanupSession()).toBe(false);
    },
  );
  it.each(
    (["recovery intent", "terminal"] as const).flatMap((stage) =>
      (["held ACK", "known refusal", "released before ACK", "confirmed Stop"] as const).map(
        (timing) => ({ stage, timing }),
      ),
    ),
  )("finishes staged settlement for $stage after $timing", async ({ stage, timing }) => {
    const f = fixture();
    const registered = f.register();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.writes[1]!.gate.resolve();
    await registered;
    const entry = f.runs.get(f.registration.runId)!;
    const successor = {
      ...structuredClone(entry),
      runId: "successor",
      generation: (entry.generation ?? 0) + 1,
    };
    f.runs.set(successor.runId, successor);
    let settled = false;
    const settlement = f.scope.settleFailedLaunch("original launch failed");
    const joined = settlement.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const attemptIndex = stage === "recovery intent" ? 2 : 3;
    if (stage === "terminal") {
      f.writes[2]!.gate.resolve();
      await vi.waitFor(() => expect(f.writes).toHaveLength(4));
    }
    const claim = f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
    try {
      if (!claim) {
        throw new Error("missing staged-settlement claim");
      }
      if (timing === "released before ACK") {
        expect(
          f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim }),
        ).toBe(true);
      } else if (timing === "confirmed Stop") {
        entry.killIntent = undefined;
        entry.killReconciliation = { killedAt: 123 };
        entry.execution = { ...entry.execution, status: "terminal", endedAt: 123 };
        f.options.persistOrThrow(entry.runId);
      }
      if (timing === "known refusal") {
        expect(f.writes[attemptIndex]!.assertCurrent).toThrow("lost its original owner");
        f.writes[attemptIndex]!.gate.reject(
          new SubagentRegistryWriteError(
            "not-committed",
            new Error("claim superseded staged write"),
          ),
        );
      } else {
        f.writes[attemptIndex]!.gate.resolve();
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (timing === "confirmed Stop") {
        await expect(settlement).resolves.toBeUndefined();
        expect(entry.execution.endedAt).toBe(123);
        expect(f.writes).toHaveLength(attemptIndex + 1);
        return;
      }
      expect(settled).toBe(false);
      if (timing !== "released before ACK") {
        expect(f.writes).toHaveLength(attemptIndex + 1);
        expect(
          f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim }),
        ).toBe(true);
      }
      await vi.waitFor(() => expect(f.writes).toHaveLength(attemptIndex + 2));
      const retry = f.writes[attemptIndex + 1]!;
      expect(retry.snapshot.get(entry.runId)?.execution.suppressSessionEffects).toBe(true);
      expect(retry.snapshot.get(entry.runId)?.queuedLaunch).toBeUndefined();
      retry.gate.resolve();
      if (stage === "recovery intent") {
        await vi.waitFor(() => expect(f.writes).toHaveLength(5));
        f.writes[4]!.gate.resolve();
      }
      await expect(settlement).resolves.toBeUndefined();
      expect(entry.execution.status).toBe("terminal");
      expect(f.runs.get(successor.runId)).toBe(successor);
      expect(successor.execution.status).toBe("queued");
    } finally {
      if (claim && entry.killIntent === claim) {
        f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim });
      }
      f.acknowledgeAllWrites();
      await joined;
    }
  });
  it.each([
    "initial intent acknowledgement",
    "initial intent refusal",
    "descriptor acknowledgement",
    "successor during claim",
    "retained failure after registration",
  ] as const)(
    "keeps the actual spawn pipeline pending when a kill claim arrives during %s",
    async (timing) => {
      const f = fixture();
      const initialIntent = timing.startsWith("initial intent");
      const retainedFailure = timing === "retained failure after registration";
      const hasSuccessor = timing === "successor during claim" || retainedFailure;
      let retainedSettlement: Promise<void> | undefined;
      let claim: SubagentRunRecord["killIntent"];
      const claimRun = () => {
        const entry = f.runs.get(f.registration.runId)!;
        claim = f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
        expect(claim).toBeDefined();
      };
      const cleanup = vi.fn(async () => {});
      const release = vi.fn();
      let completed = false;
      const pipeline = runSpawnPipeline({
        adapter: {
          initialize: async () => ({}),
          dispatchTurn: async () => ({ runId: f.registration.runId }),
          cleanupOnFailure: cleanup,
        },
        buildRegistration: () => f.registration,
        progressSessionKey: "agent:main:main",
        admissionReservation: { release },
      }).then((result) => {
        completed = true;
        return result;
      });
      try {
        await vi.waitFor(() => expect(f.writes).toHaveLength(1));
        if (initialIntent) {
          claimRun();
          if (timing === "initial intent refusal") {
            expect(f.writes[0]!.assertCurrent).toThrow("lost its original run owner");
            f.writes[0]!.gate.reject(
              new SubagentRegistryWriteError("not-committed", new Error("claimed before commit")),
            );
          } else {
            f.writes[0]!.gate.resolve();
          }
        } else {
          f.writes[0]!.gate.resolve();
        }
        if (!initialIntent) {
          await vi.waitFor(() => expect(f.writes).toHaveLength(2));
          let registered: Awaited<typeof pipeline> | undefined;
          if (retainedFailure) {
            f.writes[1]!.gate.resolve();
            registered = await pipeline;
          }
          claimRun();
          if (hasSuccessor) {
            const original = f.runs.get(f.registration.runId)!;
            f.runs.set("successor", {
              ...structuredClone(original),
              runId: "successor",
              generation: (original.generation ?? 0) + 1,
              killIntent: undefined,
            });
            f.options.persistOrThrow();
          }
          if (registered) {
            if (!registered.ok || !registered.registrationScope) {
              throw new Error("missing acknowledged registration scope");
            }
            completed = false;
            retainedSettlement = registered.registrationScope
              .settleFailedLaunch("original launch lost session ownership")
              .then(() => {
                completed = true;
              });
          } else {
            f.writes[1]!.gate.resolve();
          }
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completed).toBe(false);
        if (!retainedFailure) {
          expect(release).not.toHaveBeenCalled();
        }
        expect(cleanup).not.toHaveBeenCalled();
        const entry = f.runs.get(f.registration.runId)!;
        if (!claim) {
          throw new Error("missing provisional claim");
        }
        expect(
          f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim }),
        ).toBe(true);
        if (timing === "initial intent refusal") {
          await vi.waitFor(() => expect(f.writes).toHaveLength(2));
          expect(f.writes[1]!.snapshot.get(entry.runId)?.queuedLaunch).toBeUndefined();
          f.writes[1]!.gate.resolve();
        }
        const expectedWrites = timing === "initial intent acknowledgement" ? 2 : 3;
        await vi.waitFor(() => expect(f.writes).toHaveLength(expectedWrites));
        const publication = f.writes[expectedWrites - 1]!;
        if (hasSuccessor) {
          expect(publication.snapshot.get(entry.runId)?.queuedLaunch).toBeUndefined();
          publication.gate.resolve();
          await vi.waitFor(() => expect(f.writes).toHaveLength(4));
          expect(f.writes[3]!.snapshot.get(entry.runId)?.execution).toMatchObject({
            status: "terminal",
            suppressSessionEffects: true,
          });
          f.writes[3]!.gate.resolve();
          await retainedSettlement;
          expect((await pipeline).ok).toBe(retainedFailure);
          expect(f.runs.get("successor")?.execution.status).toBe("queued");
        } else {
          expect(publication.snapshot.get(entry.runId)?.queuedLaunch).toEqual(
            f.registration.queuedLaunch,
          );
          publication.gate.resolve();
          const result = await pipeline;
          expect(result.ok).toBe(true);
          expect(result.ok && result.registrationScope?.canLaunch()).toBe(true);
          expect(entry.queuedLaunch).toEqual(f.registration.queuedLaunch);
          expect(cleanup).not.toHaveBeenCalled();
        }
      } finally {
        const entry = f.runs.get(f.registration.runId);
        if (entry && claim && entry.killIntent === claim) {
          f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim });
        }
        f.acknowledgeAllWrites();
        markGatewayRestartDraining();
        await pipeline;
        await retainedSettlement;
      }
    },
  );

  it("guards a late claim during failure cleanup without replaying admitted rollback", async () => {
    const { createCollectorLaunchCallbacks } = await import("../spawn/subagent-spawn-collector.js");
    const f = fixture();
    const registered = f.register();
    f.writes[0]!.gate.resolve();
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.writes[1]!.gate.resolve();
    await registered;
    const entry = f.runs.get(f.registration.runId)!;
    const entered = createDeferred();
    const gate = createDeferred();
    const rollback = vi.fn(() => {
      entered.resolve();
      return gate.promise;
    });
    const effect = vi.fn();
    const callbacks = createCollectorLaunchCallbacks({
      childRunId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
      registrationScope: f.scope,
      preparation: { rollback, dispose: async () => {} },
      provisionalSessionIdentity: {},
      launchChildRun: async () => {
        throw new Error("dispatch refused");
      },
      recordParticipant: vi.fn(),
      emitSpawnLifecycleHooks: async () => {},
      cleanupFailedSpawn: async () => {
        await gate.promise;
        const current = f.scope.canCleanupSession();
        if (current) {
          effect();
        }
        return { attachmentsRemoved: current, sessionDeleted: current };
      },
    });
    let completed = false;
    const pending = callbacks
      .start()
      .catch(callbacks.onStartFailure)
      .then(() => {
        completed = true;
      });
    await entered.promise;
    const claim = f.manager.claimSubagentRunKill({ runId: entry.runId, expected: entry });
    try {
      expect(claim).toBeDefined();
      expect(f.scope.canCleanupSession()).toBe(false);
      gate.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(effect).not.toHaveBeenCalled();
      expect(completed).toBe(false);
    } finally {
      if (claim) {
        f.manager.releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim });
      }
      gate.resolve();
      f.acknowledgeAllWrites();
      await pending;
    }
    expect(rollback).toHaveBeenCalledOnce();
    expect(entry.execution.status).toBe("terminal");
  });
}
