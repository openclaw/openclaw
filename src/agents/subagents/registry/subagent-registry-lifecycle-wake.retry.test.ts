import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { SqliteWorkerCommand } from "../../../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../../sessions/session-controller.context.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import type { OpenClawStateWorkerOperations } from "../../../state/openclaw-state-worker-contract.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../../../state/openclaw-state-worker-store.types.js";
import { createOperationalRunInstanceRef } from "../../operational-run-instance.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import {
  armRequesterWake,
  currentCompletionRun,
  records,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
  withSubagentCompletionWorkerState,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { scheduleRequesterSettleWake } from "./subagent-registry-lifecycle-wake.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { admitRequesterTurnForTest } from "./subagent-requester-turn-liveness.test-support.js";

// mock-isolation: The retry driver owns its registry lifecycle; importing the global registry would install a competing owner.
vi.mock("./subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

const storedRun = (input: ReturnType<typeof records>) =>
  loadSubagentRegistryFromSqlite().get(input.subagent.runId);
const storedWake = (input: ReturnType<typeof records>) => storedRun(input)?.requesterSettleWake;
function seedDriver(
  database: Parameters<Parameters<typeof withSubagentCompletionWorkerState>[0]>[0],
  input: ReturnType<typeof records>,
) {
  seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
  return requesterWakeDriver([input]);
}

function isSubagentCompletionMutation(
  command: Parameters<DomainScope["execute"]>[0],
): command is Extract<
  SqliteWorkerCommand<OpenClawStateWorkerOperations>,
  { type: "sessionDelivery.mutateSubagentCompletion" }
> {
  return command.type === "sessionDelivery.mutateSubagentCompletion";
}

describe("requester settle retry lifetime", () => {
  it.each(["same", "other", "unbound"] as const)(
    "suppresses a stop notification only for its physically admitted requester (%s store)",
    async (store) => {
      await withSubagentCompletionWorkerState(async (database) => {
        const input = armRequesterWake(records());
        const stateDir = path.dirname(database.path);
        const logicalStore = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const physicalStore = path.join(
          stateDir,
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        );
        input.subagent.requesterStorePath =
          store === "unbound" ? undefined : physicalStore + (store === "other" ? ".other" : "");
        const driver = seedDriver(database, input);
        const admitted = await admitRequesterTurnForTest(
          input.subagent.requesterSessionKey,
          logicalStore,
        );
        try {
          await withSessionControllerOwner(admitted.operation, () =>
            driver.controller.retireSubagentObligations(currentCompletionRun(input), () => {}),
          );
          expect(currentCompletionRun(input).suppressCompletionDelivery).toBe(
            store === "same" ? true : undefined,
          );
        } finally {
          admitted.operation.complete();
          await admitted.operation.ownerSettlement;
          driver.controller.clearRuntimeState();
        }
      });
    },
  );

  it.each([false, true])(
    "finishes a wake after its originating tool caller expires (restored=%s)",
    async (restored) => {
      await withSubagentCompletionWorkerState(async (database) => {
        const input = armRequesterWake(records());
        const driver = seedDriver(database, input);
        if (restored) {
          driver.controller.markRequesterSettleWakeRestored(input.subagent);
        }
        const origin = new AbortController();
        const caller = {
          agentId: "main",
          sessionKey: input.subagent.requesterSessionKey,
          operationalRunInstance: createOperationalRunInstanceRef("originating-wake-turn"),
          receiptAuthority: () => !origin.signal.aborted,
          approvalSignals: [origin.signal],
        };
        const entered = createDeferred();
        const release = createDeferred();
        driver.wake.mockImplementation(async (params) => {
          const assertCaller = captureGatewayToolCallerAssertion();
          entered.resolve();
          await release.promise;
          assertCaller?.("agent");
          expect(params.isSourceCurrent()).toBe(true);
          await params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
          );
          return true;
        });
        const running = withGatewayToolCallerIdentity(caller, () => driver.run());
        try {
          await awaitGateBeforeSettlement(entered.promise, running, "Wake did not start");
          origin.abort();
          await withGatewayToolCallerIdentity(caller, () => {
            expect(() => captureGatewayToolCallerAssertion()?.("agent")).toThrow(
              "agent tool caller authority is no longer active",
            );
          });
          release.resolve();
          await running;
          expect(driver.warn).not.toHaveBeenCalled();
          expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
          expect(storedWake(input)).toBeUndefined();
        } finally {
          release.resolve();
          await running;
          driver.controller.clearRuntimeState();
        }
      });
    },
  );

  it.each(["before scheduling", "while waiting for recovery capacity"] as const)(
    "defers a stopped pause notice until obligation retirement: %s",
    async (stopAt) => {
      await withSubagentCompletionWorkerState(async (database) => {
        const input = armRequesterWake(records());
        input.subagent.pauseReason = "sessions_yield";
        input.subagent.execution.outcome = undefined;
        input.subagent.endedReason = undefined;
        input.subagent.delivery = { status: "pending" };
        input.subagent.requesterSettleWake = {
          ...input.subagent.requesterSettleWake!,
          requesterYieldBatch: true,
          pauseNotice: { acknowledgment: "Waiting for direction" },
        };
        const driver = seedDriver(database, input);
        const releaseCapacity = createDeferred();
        const capacityOccupied = createDeferred();
        let occupied = 0;
        const capacity: Promise<unknown>[] = [];
        const observedNotices: unknown[] = [];
        driver.wake.mockImplementation(async (params) => {
          observedNotices.push(params.settledEntry.requesterSettleWake?.pauseNotice);
          await params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
          );
          return true;
        });
        const stop = () =>
          mutateSubagentRuns([input.subagent.runId], (rows) => {
            const next = structuredClone(rows.get(input.subagent.runId)!);
            next.pauseReason = undefined;
            next.endedReason = "subagent-killed";
            next.execution.outcome = { status: "error", error: "subagent run terminated" };
            return { value: undefined, postimages: new Map([[next.runId, next]]) };
          });
        const drainScheduled = observeRootWork();
        try {
          if (stopAt === "before scheduling") {
            await stop();
          } else {
            driver.controller.markRequesterSettleWakeRestored(input.subagent);
            for (let slot = 0; slot < 2; slot++) {
              capacity.push(
                driver.controller.runBackgroundWork(input.subagent, async () => {
                  occupied += 1;
                  if (occupied === 2) {
                    capacityOccupied.resolve();
                  }
                  await releaseCapacity.promise;
                }),
              );
            }
            await awaitGateBeforeSettlement(
              capacityOccupied.promise,
              Promise.all(capacity),
              "Recovery capacity was not occupied",
            );
          }
          driver.controller.resumeRequesterSettleWake(
            input.subagent.runId,
            currentCompletionRun(input),
          );
          if (stopAt === "while waiting for recovery capacity") {
            expect(driver.wake).not.toHaveBeenCalled();
            await stop();
          }
          releaseCapacity.resolve();
          await Promise.all(capacity);
          await drainScheduled();
          expect(driver.wake).not.toHaveBeenCalled();
          expect(storedWake(input)?.pauseNotice).toEqual({
            acknowledgment: "Waiting for direction",
          });

          const drainRetirement = observeRootWork();
          try {
            await driver.controller.retireSubagentObligations(
              currentCompletionRun(input),
              () => {},
            );
          } finally {
            await drainRetirement();
          }
          expect(driver.wake).toHaveBeenCalledOnce();
          expect(observedNotices).toEqual([undefined]);
          expect(driver.warn).not.toHaveBeenCalled();
          expect(storedWake(input)).toBeUndefined();
        } finally {
          releaseCapacity.resolve();
          await Promise.all(capacity);
          await drainScheduled();
          driver.controller.clearRuntimeState();
        }
      });
    },
  );

  it.each([
    { trigger: "descendant event", nextAttemptAt: undefined },
    { trigger: "stale deadline", nextAttemptAt: 5_000 },
  ] as const)(
    "waits without repeated preparation or writes until $trigger (retry=$nextAttemptAt)",
    async ({ trigger, nextAttemptAt }) => {
      await withSubagentCompletionWorkerState(async (database) => {
        resetGatewayWorkAdmission();
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const input = armRequesterWake(records());
        input.subagent.requesterSettleWake!.nextAttemptAt = nextAttemptAt;
        const driver = seedDriver(database, input);
        const initial = structuredClone(currentCompletionRun(input).requesterSettleWake);
        driver.wake.mockImplementation(async (params) => {
          if (driver.wake.mock.calls.length === 1) {
            params.onDescendantsPending?.(trigger === "stale deadline" ? 310_000 : undefined);
            return false;
          }
          await params.completeBatch([params.settledEntry], 1);
          return true;
        });
        try {
          await driver.run();
          expect(driver.wake).toHaveBeenCalledOnce();
          for (let sweep = 0; sweep < 5; sweep++) {
            await driver.run();
            await vi.advanceTimersByTimeAsync(30_000);
          }
          expect(driver.wake).toHaveBeenCalledOnce();
          expect(storedWake(input)).toEqual(initial);
          if (trigger === "descendant event") {
            scheduleRequesterSettleWake(
              driver.controller,
              input.subagent.runId,
              currentCompletionRun(input),
            );
          } else {
            await vi.advanceTimersByTimeAsync(150_000);
          }
          await vi.waitFor(() => {
            expect(driver.wake).toHaveBeenCalledTimes(2);
            expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
          });
        } finally {
          driver.controller.clearRuntimeState();
          vi.useRealTimers();
          resetGatewayWorkAdmission();
        }
      });
    },
  );

  it.each([
    { name: "active descendant", deadline: undefined },
    { name: "terminal delivery", deadline: 310_000 },
  ])(
    "releases $name waits when the requester already knows the cohort retired",
    async ({ deadline }) => {
      await withSubagentCompletionWorkerState(async (database) => {
        resetGatewayWorkAdmission();
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const input = armRequesterWake(records());
        input.subagent.requesterSettleWake!.requesterYieldBatch = true;
        const driver = seedDriver(database, input);
        driver.wake.mockImplementation(async (params) => {
          params.onDescendantsPending?.(deadline);
          return false;
        });
        try {
          await driver.run();
          expect(driver.controller.waitingRequesterSettleWakes.size).toBe(1);
          await driver.controller.retireSubagentObligations(currentCompletionRun(input), () => {}, {
            requesterNotified: true,
          });
          const stored = storedRun(input);
          expect(stored).toBeDefined();
          expect(stored?.requesterSettleWake).toBeUndefined();
          expect(driver.controller.waitingRequesterSettleWakes.size).toBe(0);
          await vi.advanceTimersByTimeAsync(310_000);
          expect(driver.wake).toHaveBeenCalledOnce();
        } finally {
          driver.controller.clearRuntimeState();
          vi.useRealTimers();
          resetGatewayWorkAdmission();
        }
      });
    },
  );

  it("retains a descendant event arriving before an in-flight read records its wait", async () => {
    await withSubagentCompletionWorkerState(async (database) => {
      const input = armRequesterWake(records());
      const driver = seedDriver(database, input);
      const reading = createDeferred();
      const finishRead = createDeferred();
      driver.wake.mockImplementation(async (params) => {
        if (driver.wake.mock.calls.length === 1) {
          reading.resolve();
          await finishRead.promise;
          params.onDescendantsPending?.();
          return false;
        }
        await params.completeBatch(
          [params.settledEntry],
          params.settledEntry.requesterSettleWake?.rearmGeneration,
        );
        return true;
      });
      const first = driver.run();
      try {
        await reading.promise;
        scheduleRequesterSettleWake(
          driver.controller,
          input.subagent.runId,
          currentCompletionRun(input),
        );
        finishRead.resolve();
        await first;
        expect(driver.wake).toHaveBeenCalledTimes(2);
        expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
      } finally {
        finishRead.resolve();
        await first;
        driver.controller.clearRuntimeState();
      }
    });
  });

  it.each([
    { mode: "current entry", rejectCompletion: false },
    { mode: "replacement entry", rejectCompletion: false },
    { mode: "current entry", rejectCompletion: true },
  ] as const)(
    "preserves retry ownership after the originating scope drains: $mode, rejected=$rejectCompletion",
    async ({ mode, rejectCompletion }) => {
      await withSubagentCompletionWorkerState(async (database) => {
        resetGatewayWorkAdmission();
        const origin = new AsyncWorkScope();
        const input = armRequesterWake(records());
        input.subagent.expectsCompletionMessage = false;
        input.subagent.delivery = { status: "not_required" };
        input.subagent.requesterSettleWake!.progressOperationId = "retained-progress-receipt";
        const driver = seedDriver(database, input);
        const wakeSignals: Array<AbortSignal | undefined> = [];
        const finalized = vi.fn();
        driver.wake.mockImplementation(async (params) => {
          wakeSignals.push(getAsyncWorkSignal());
          if (wakeSignals.length === 1) {
            return false;
          }
          await params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
            undefined,
            finalized,
          );
          return true;
        });
        try {
          await origin.run(() => driver.run());
          expect(driver.wake).toHaveBeenCalledOnce();
          const owedWake = structuredClone(currentCompletionRun(input).requesterSettleWake);
          expect(storedWake(input)).toEqual(owedWake);
          await origin.drain();
          expect(origin.signal.aborted).toBe(true);
          const deliveryBeforeCompletion = structuredClone(currentCompletionRun(input).delivery);
          if (mode === "replacement entry") {
            await mutateSubagentRuns([input.subagent.runId], (rows) => {
              const next = structuredClone(rows.get(input.subagent.runId)!);
              next.generation = (next.generation ?? 0) + 1;
              return { value: undefined, postimages: new Map([[next.runId, next]]) };
            });
          }
          const replacement = currentCompletionRun(input);
          if (rejectCompletion) {
            database.db.exec(
              "CREATE TRIGGER reject_quiet_wake BEFORE UPDATE ON subagent_runs WHEN json_type(NEW.payload_json, '$.requesterSettleWake') IS NULL BEGIN SELECT RAISE(ABORT, 'no-wake persistence unavailable'); END",
            );
          }
          await driver.run(input.subagent);
          if (mode === "replacement entry") {
            expect(driver.wake).toHaveBeenCalledOnce();
            expect(currentCompletionRun(input)).toBe(replacement);
            expect(storedWake(input)).toEqual(owedWake);
          } else {
            expect(driver.wake).toHaveBeenCalledTimes(2);
            expect(wakeSignals[1]).toBeDefined();
            expect(wakeSignals[1]).not.toBe(origin.signal);
            if (rejectCompletion) {
              expect(storedWake(input)).toEqual(owedWake);
              expect(currentCompletionRun(input).delivery).toEqual(deliveryBeforeCompletion);
              expect(finalized).not.toHaveBeenCalled();
              database.db.exec("DROP TRIGGER reject_quiet_wake");
              await driver.sweep();
              expect(driver.wake).toHaveBeenCalledTimes(2);
              expect(driver.warn).toHaveBeenCalled();
            }
            expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
            expect(storedWake(input)).toBeUndefined();
            expect(finalized).toHaveBeenCalledOnce();
          }
          if (!rejectCompletion) {
            expect(driver.warn).not.toHaveBeenCalled();
          }
        } finally {
          database.db.exec("DROP TRIGGER IF EXISTS reject_quiet_wake");
          driver.controller.clearRuntimeState();
          await origin.drain();
          resetGatewayWorkAdmission();
        }
      });
    },
  );

  it("retains a delivered batch through repeated persistence failures without redelivery", async () => {
    const failures = 4;
    await withSubagentCompletionWorkerState(async (database) => {
      const first = records();
      const sibling = records();
      sibling.subagent.runId = "retry-sibling";
      sibling.subagent.childSessionKey = "agent:main:subagent:retry-sibling";
      const inputs = [first, sibling];
      const batchRunIds = inputs.map(({ subagent }) => subagent.runId);
      for (const input of inputs) {
        armRequesterWake(input, batchRunIds);
        seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
      }
      const driver = requesterWakeDriver(inputs);
      const transport = vi.fn();
      const finalized = vi.fn();
      let settlementWrites = 0;
      const worker = probe.command(stateWorker, (command, options, scope) => {
        if (
          isSubagentCompletionMutation(command) &&
          command.input.mutation.kind === "requesterBatch"
        ) {
          settlementWrites += 1;
          if (settlementWrites === failures + 1) {
            database.db.exec("DROP TRIGGER reject_delivered_batch");
          }
        }
        return scope.execute(command, options);
      });
      database.db.exec(
        "CREATE TRIGGER reject_delivered_batch BEFORE UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.delivery.status') = 'delivered' BEGIN SELECT RAISE(ABORT, 'delivered outcome persistence unavailable'); END",
      );
      driver.wake.mockImplementation(async (params) => {
        const batch = () => inputs.map((input) => currentCompletionRun(input));
        await params.transitionBatch(
          batch(),
          { status: "dispatching", attemptCount: 1, rearmGeneration: 1, batchRunIds },
          () => {},
        );
        transport();
        await params.completeBatch(
          batch(),
          1,
          { delivered: true, path: "direct", deliveredAt: 5_000 },
          finalized,
        );
        return true;
      });
      try {
        await driver.run();
        for (let event = 0; event <= failures; event += 1) {
          if (settlementWrites > failures) {
            break;
          }
          expect(transport).toHaveBeenCalledOnce();
          expect(finalized).not.toHaveBeenCalled();
          for (const input of inputs) {
            const stored = storedRun(input);
            expect(stored?.delivery?.status).toBe("in_progress");
            expect(stored?.requesterSettleWake).toMatchObject({
              rearmGeneration: 1,
              batchRunIds,
            });
          }
          // No child changes again; the existing sweep must adopt the retained receipt.
          await driver.sweep();
        }
        expect(settlementWrites).toBe(failures + 1);
        expect(driver.warn).toHaveBeenCalled();
        expect(transport).toHaveBeenCalledOnce();
        expect(finalized).toHaveBeenCalledOnce();
        for (const input of inputs) {
          const stored = storedRun(input);
          expect(stored?.delivery).toMatchObject({ status: "delivered", deliveredAt: 5_000 });
          expect(stored?.requesterSettleWake).toBeUndefined();
        }
      } finally {
        database.db.exec("DROP TRIGGER IF EXISTS reject_delivered_batch");
        driver.controller.clearRuntimeState();
        worker.mockRestore();
      }
    });
  });

  it("recovers a failed replay publication through the existing sweep", async () => {
    await withSubagentCompletionWorkerState(async (database) => {
      const input = armRequesterWake(records());
      const driver = seedDriver(database, input);
      const attempts = vi.fn();
      const batchRunIds = [input.subagent.runId];
      const pending = {
        ...structuredClone(input.subagent.requesterSettleWake!),
        nextAttemptAt: Date.now() + 30_000,
      };
      database.db.exec(
        "CREATE TRIGGER reject_wake_publication BEFORE UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.requesterSettleWake.status') = 'pending' BEGIN SELECT RAISE(ABORT, 'wake publication unavailable'); END",
      );
      driver.wake.mockImplementation(async (params) => {
        await params.transitionBatch(
          [currentCompletionRun(input)],
          { ...pending, status: "dispatching", attemptCount: 1, batchRunIds },
          () => {},
        );
        attempts();
        if (attempts.mock.calls.length === 1) {
          await params.transitionBatch([currentCompletionRun(input)], pending, () => {});
          return false;
        }
        await params.completeBatch([currentCompletionRun(input)], pending.rearmGeneration, {
          delivered: true,
          path: "direct",
          deliveredAt: 5_000,
        });
        return true;
      });
      try {
        await driver.run();
        expect(attempts).toHaveBeenCalledOnce();
        expect(storedWake(input)).toBeDefined();
        database.db.exec("DROP TRIGGER reject_wake_publication");
        await driver.sweep();
        expect(attempts).toHaveBeenCalledTimes(2);
        expect(driver.wake).toHaveBeenCalledTimes(2);
        expect(storedWake(input)).toBeUndefined();
        expect(storedRun(input)?.delivery?.status).toBe("delivered");
      } finally {
        database.db.exec("DROP TRIGGER IF EXISTS reject_wake_publication");
        driver.controller.clearRuntimeState();
      }
    });
  });

  it("does not settle a new wake generation with a retained prior outcome", async () => {
    await withSubagentCompletionWorkerState(async (database) => {
      const input = armRequesterWake(records());
      const driver = seedDriver(database, input);
      const transport = vi.fn();
      const finalized = vi.fn();
      driver.wake.mockImplementation(async (params) => {
        const generation = params.settledEntry.requesterSettleWake?.rearmGeneration;
        await params.transitionBatch(
          [params.settledEntry],
          {
            status: "dispatching",
            attemptCount: 1,
            rearmGeneration: generation,
            batchRunIds: [input.subagent.runId],
          },
          () => {},
        );
        transport(generation);
        await params.completeBatch(
          [currentCompletionRun(input)],
          generation,
          { delivered: true, path: "direct", deliveredAt: generation === 1 ? 5_000 : 6_000 },
          () => finalized(generation),
        );
        return true;
      });
      database.db.exec(
        "CREATE TRIGGER reject_old_outcome BEFORE UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.delivery.status') = 'delivered' BEGIN SELECT RAISE(ABORT, 'old outcome persistence unavailable'); END",
      );
      try {
        await driver.run();
        expect(transport.mock.calls).toEqual([[1]]);
        expect(finalized).not.toHaveBeenCalled();
        database.db.exec("DROP TRIGGER reject_old_outcome");
        await mutateSubagentRuns([input.subagent.runId], (rows) => {
          const next = structuredClone(rows.get(input.subagent.runId)!);
          next.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
            batchRunIds: [next.runId],
          };
          next.delivery = { status: "pending", generation: 2 };
          return { value: undefined, postimages: new Map([[next.runId, next]]) };
        });
        await driver.run(currentCompletionRun(input));
        expect(transport.mock.calls).toEqual([[1], [2]]);
        expect(finalized.mock.calls).toEqual([[2]]);
        const stored = storedRun(input);
        expect(stored?.delivery).toMatchObject({
          status: "delivered",
          generation: 2,
          deliveredAt: 6_000,
        });
        expect(stored?.requesterSettleWake).toBeUndefined();
      } finally {
        database.db.exec("DROP TRIGGER IF EXISTS reject_old_outcome");
        driver.controller.clearRuntimeState();
      }
    });
  });
});
