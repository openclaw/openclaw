import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { admitReplyTurn } from "../../../auto-reply/reply/reply-turn-admission.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry.js";
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

// mock-isolation: The retry driver owns its registry lifecycle; importing the global registry would install a competing owner.
vi.mock("./subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

function isSubagentCompletionMutation(
  command: Parameters<DomainScope["execute"]>[0],
): command is Extract<
  SqliteWorkerCommand<OpenClawStateWorkerOperations>,
  { type: "sessionDelivery.mutateSubagentCompletion" }
> {
  return command.type === "sessionDelivery.mutateSubagentCompletion";
}

function createWakeFixture(
  database: Parameters<Parameters<typeof withSubagentCompletionWorkerState>[0]>[0],
  input = armRequesterWake(records()),
) {
  seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
  return {
    input,
    ...requesterWakeDriver([input]),
    current: () => currentCompletionRun(input),
    stored: () => loadSubagentRegistryFromSqlite().get(input.subagent.runId),
  };
}

type WakeParams = Parameters<ReturnType<typeof requesterWakeDriver>["wake"]>[0];
const delivered = (deliveredAt = 5_000) =>
  ({ delivered: true, path: "direct", deliveredAt }) as const;
const dispatchWake = (
  params: WakeParams,
  batch: Parameters<WakeParams["transitionBatch"]>[0],
  state: Omit<Parameters<WakeParams["transitionBatch"]>[1], "status" | "attemptCount">,
) => params.transitionBatch(batch, { ...state, status: "dispatching", attemptCount: 1 }, () => {});
const updateRun = (
  input: ReturnType<typeof records>,
  update: (run: ReturnType<typeof records>["subagent"]) => void,
) =>
  mutateSubagentRuns([input.subagent.runId], (rows) => {
    const next = structuredClone(rows.get(input.subagent.runId)!);
    update(next);
    return { value: undefined, postimages: new Map([[next.runId, next]]) };
  });

const completeWake = async (params: WakeParams, finalized?: () => void) => {
  await params.completeBatch(
    [params.settledEntry],
    params.settledEntry.requesterSettleWake?.rearmGeneration,
    undefined,
    finalized,
  );
  return true;
};

it.each(["same", "other", "unbound"] as const)(
  "suppresses a stop notification only for its physically admitted requester (%s store)",
  (store) =>
    withSubagentCompletionWorkerState(async (database) => {
      const input = armRequesterWake(records());
      const stateDir = path.dirname(database.path);
      const logicalStore = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const physicalStore = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
      input.subagent.requesterStorePath =
        store === "unbound" ? undefined : physicalStore + (store === "other" ? ".other" : "");
      const { controller, current } = createWakeFixture(database, input);
      const requester = {
        agentId: "main",
        sessionKey: input.subagent.requesterSessionKey,
        storePath: logicalStore,
      };
      await replaceSessionEntry(requester, { sessionId: "requester-session", updatedAt: 1 });
      const admitted = await admitReplyTurn({
        ...requester,
        sessionId: "requester-session",
        kind: "visible",
        resetTriggered: false,
      });
      if (admitted.status !== "owned") {
        throw new Error("Requester did not acquire its turn");
      }
      try {
        await withSessionControllerOwner(admitted.operation, () =>
          controller.retireSubagentObligations(current(), () => {}),
        );
        expect(current().suppressCompletionDelivery).toBe(store === "same" ? true : undefined);
      } finally {
        admitted.operation.complete();
        await admitted.operation.ownerSettlement;
        controller.clearRuntimeState();
      }
    }),
);

it.each([false, true])(
  "finishes a wake after its originating tool caller expires (restored=%s)",
  (restored) =>
    withSubagentCompletionWorkerState(async (database) => {
      const { input, controller, wake, warn, run, current, stored } = createWakeFixture(database);
      if (restored) {
        controller.markRequesterSettleWakeRestored(input.subagent);
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
      wake.mockImplementation(async (params) => {
        const assertCaller = captureGatewayToolCallerAssertion();
        entered.resolve();
        await release.promise;
        assertCaller?.("agent");
        expect(params.isSourceCurrent()).toBe(true);
        return completeWake(params);
      });
      const running = withGatewayToolCallerIdentity(caller, () => run());
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
        expect(warn).not.toHaveBeenCalled();
        expect(current().requesterSettleWake).toBeUndefined();
        expect(stored()?.requesterSettleWake).toBeUndefined();
      } finally {
        release.resolve();
        await running;
        controller.clearRuntimeState();
      }
    }),
);

it.each(["before scheduling", "while waiting for recovery capacity"] as const)(
  "defers a stopped pause notice until obligation retirement: %s",
  (stopAt) =>
    withSubagentCompletionWorkerState(async (database) => {
      const input = armRequesterWake(records());
      Object.assign(input.subagent, {
        pauseReason: "sessions_yield",
        endedReason: undefined,
        delivery: { status: "pending" },
      });
      input.subagent.execution.outcome = undefined;
      Object.assign(input.subagent.requesterSettleWake!, {
        requesterYieldBatch: true,
        pauseNotice: { acknowledgment: "Waiting for direction" },
      });
      const { controller, wake, warn, current, stored } = createWakeFixture(database, input);
      const releaseCapacity = createDeferred();
      const capacityOccupied = createDeferred();
      let occupied = 0;
      const capacity: Promise<unknown>[] = [];
      const observedNotices: unknown[] = [];
      wake.mockImplementation(async (params) => {
        observedNotices.push(params.settledEntry.requesterSettleWake?.pauseNotice);
        return completeWake(params);
      });
      const stop = () =>
        updateRun(input, (next) => {
          next.pauseReason = undefined;
          next.endedReason = "subagent-killed";
          next.execution.outcome = { status: "error", error: "subagent run terminated" };
        });
      const drainScheduled = observeRootWork();
      try {
        if (stopAt === "before scheduling") {
          await stop();
        } else {
          controller.markRequesterSettleWakeRestored(input.subagent);
          for (let slot = 0; slot < 2; slot++) {
            capacity.push(
              controller.runBackgroundWork(input.subagent, async () => {
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
        controller.resumeRequesterSettleWake(input.subagent.runId, current());
        if (stopAt === "while waiting for recovery capacity") {
          expect(wake).not.toHaveBeenCalled();
          await stop();
        }
        releaseCapacity.resolve();
        await Promise.all(capacity);
        await drainScheduled();
        expect(wake).not.toHaveBeenCalled();
        expect(stored()?.requesterSettleWake?.pauseNotice).toEqual({
          acknowledgment: "Waiting for direction",
        });

        const drainRetirement = observeRootWork();
        try {
          await controller.retireSubagentObligations(current(), () => {});
        } finally {
          await drainRetirement();
        }
        expect(wake).toHaveBeenCalledOnce();
        expect(observedNotices).toEqual([undefined]);
        expect(warn).not.toHaveBeenCalled();
        expect(stored()?.requesterSettleWake).toBeUndefined();
      } finally {
        releaseCapacity.resolve();
        await Promise.all(capacity);
        await drainScheduled();
        controller.clearRuntimeState();
      }
    }),
);

it.each([
  { trigger: "descendant event", nextAttemptAt: undefined },
  { trigger: "stale deadline", nextAttemptAt: undefined },
  { trigger: "stale deadline", nextAttemptAt: 5_000 },
] as const)(
  "waits without repeated preparation or writes until $trigger (retry=$nextAttemptAt)",
  ({ trigger, nextAttemptAt }) =>
    withSubagentCompletionWorkerState(async (database) => {
      resetGatewayWorkAdmission();
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const input = armRequesterWake(records());
      input.subagent.requesterSettleWake!.nextAttemptAt = nextAttemptAt;
      const { controller, wake, run, current, stored } = createWakeFixture(database, input);
      const initial = structuredClone(current().requesterSettleWake);
      wake.mockImplementation(async (params) => {
        if (wake.mock.calls.length === 1) {
          params.onDescendantsPending?.(trigger === "stale deadline" ? 310_000 : undefined);
          return false;
        }
        await params.completeBatch([params.settledEntry], 1);
        return true;
      });
      try {
        await run();
        expect(wake).toHaveBeenCalledOnce();
        for (let sweep = 0; sweep < 5; sweep++) {
          await run();
          await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(wake).toHaveBeenCalledOnce();
        expect(stored()?.requesterSettleWake).toEqual(initial);
        if (trigger === "descendant event") {
          scheduleRequesterSettleWake(controller, input.subagent.runId, current());
        } else {
          await vi.advanceTimersByTimeAsync(150_000);
        }
        await vi.waitFor(() => {
          expect(wake).toHaveBeenCalledTimes(2);
          expect(current().requesterSettleWake).toBeUndefined();
        });
      } finally {
        controller.clearRuntimeState();
        vi.useRealTimers();
        resetGatewayWorkAdmission();
      }
    }),
);

it.each([
  { name: "active descendant", deadline: undefined },
  { name: "terminal delivery", deadline: 310_000 },
])("releases $name waits when the requester already knows the cohort retired", ({ deadline }) =>
  withSubagentCompletionWorkerState(async (database) => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const input = armRequesterWake(records());
    input.subagent.requesterSettleWake!.requesterYieldBatch = true;
    const { controller, wake, run, current, stored } = createWakeFixture(database, input);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    wake.mockImplementation(async (params) => {
      params.onDescendantsPending?.(deadline);
      return false;
    });
    try {
      await run();
      expect(controller.waitingRequesterSettleWakes.size).toBe(1);
      const deadlineTimer = [...controller.waitingRequesterSettleWakes.values()][0]?.timer;
      expect(deadlineTimer !== undefined).toBe(deadline !== undefined);
      await controller.retireSubagentObligations(current(), () => {}, {
        requesterNotified: true,
      });
      const persisted = stored();
      expect(persisted).toBeDefined();
      expect(persisted?.requesterSettleWake).toBeUndefined();
      expect(controller.waitingRequesterSettleWakes.size).toBe(0);
      if (deadline !== undefined) {
        expect(clearTimeoutSpy).toHaveBeenCalledWith(deadlineTimer);
      }
      expect(wake).toHaveBeenCalledOnce();
    } finally {
      controller.clearRuntimeState();
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
      resetGatewayWorkAdmission();
    }
  }),
);

it("retains a descendant event arriving before an in-flight read records its wait", () =>
  withSubagentCompletionWorkerState(async (database) => {
    const { input, controller, wake, run, current } = createWakeFixture(database);
    const reading = createDeferred();
    const finishRead = createDeferred();
    wake.mockImplementation(async (params) => {
      if (wake.mock.calls.length === 1) {
        reading.resolve();
        await finishRead.promise;
        params.onDescendantsPending?.();
        return false;
      }
      return completeWake(params);
    });
    const first = run();
    try {
      await reading.promise;
      scheduleRequesterSettleWake(controller, input.subagent.runId, current());
      finishRead.resolve();
      await first;
      expect(wake).toHaveBeenCalledTimes(2);
      expect(current().requesterSettleWake).toBeUndefined();
    } finally {
      finishRead.resolve();
      await first;
      controller.clearRuntimeState();
    }
  }));

it.each([
  { mode: "current entry", rejectCompletion: false },
  { mode: "replacement entry", rejectCompletion: false },
  { mode: "current entry", rejectCompletion: true },
] as const)(
  "preserves retry ownership after the originating scope drains: $mode, rejected=$rejectCompletion",
  ({ mode, rejectCompletion }) =>
    withSubagentCompletionWorkerState(async (database) => {
      resetGatewayWorkAdmission();
      const origin = new AsyncWorkScope();
      const input = armRequesterWake(records());
      input.subagent.expectsCompletionMessage = false;
      input.subagent.delivery = { status: "not_required" };
      input.subagent.requesterSettleWake!.progressOperationId = "retained-progress-receipt";
      const { controller, wake, warn, run, sweep, current, stored } = createWakeFixture(
        database,
        input,
      );
      const wakeSignals: Array<AbortSignal | undefined> = [];
      const finalized = vi.fn();
      wake.mockImplementation(async (params) => {
        wakeSignals.push(getAsyncWorkSignal());
        if (wakeSignals.length === 1) {
          return false;
        }
        return completeWake(params, finalized);
      });
      try {
        await origin.run(() => run());
        expect(wake).toHaveBeenCalledOnce();
        const owedWake = structuredClone(current().requesterSettleWake);
        expect(stored()?.requesterSettleWake).toEqual(owedWake);
        await origin.drain();
        expect(origin.signal.aborted).toBe(true);
        const deliveryBeforeCompletion = structuredClone(current().delivery);
        if (mode === "replacement entry") {
          await updateRun(input, (next) => {
            next.generation = (next.generation ?? 0) + 1;
          });
        }
        const replacement = current();
        if (rejectCompletion) {
          database.db.exec(
            "CREATE TRIGGER reject_quiet_wake BEFORE UPDATE ON subagent_runs WHEN json_type(NEW.payload_json, '$.requesterSettleWake') IS NULL BEGIN SELECT RAISE(ABORT, 'no-wake persistence unavailable'); END",
          );
        }
        await run(input.subagent);
        if (mode === "replacement entry") {
          expect(wake).toHaveBeenCalledOnce();
          expect(current()).toBe(replacement);
          expect(stored()?.requesterSettleWake).toEqual(owedWake);
        } else {
          expect(wake).toHaveBeenCalledTimes(2);
          expect(wakeSignals[1]).toBeDefined();
          expect(wakeSignals[1]).not.toBe(origin.signal);
          if (rejectCompletion) {
            expect(stored()?.requesterSettleWake).toEqual(owedWake);
            expect(current().delivery).toEqual(deliveryBeforeCompletion);
            expect(finalized).not.toHaveBeenCalled();
            database.db.exec("DROP TRIGGER reject_quiet_wake");
            await sweep();
            expect(wake).toHaveBeenCalledTimes(2);
            expect(warn).toHaveBeenCalled();
          }
          expect(current().requesterSettleWake).toBeUndefined();
          expect(stored()?.requesterSettleWake).toBeUndefined();
          expect(finalized).toHaveBeenCalledOnce();
        }
        if (!rejectCompletion) {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        database.db.exec("DROP TRIGGER IF EXISTS reject_quiet_wake");
        controller.clearRuntimeState();
        await origin.drain();
        resetGatewayWorkAdmission();
      }
    }),
);

it.each([1, 4])(
  "retains a delivered batch through %s persistence failures without redelivery",
  (failures) =>
    withSubagentCompletionWorkerState(async (database) => {
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
      const { controller, wake, warn, run, sweep } = requesterWakeDriver(inputs);
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
      wake.mockImplementation(async (params) => {
        const batch = () => inputs.map((input) => currentCompletionRun(input));
        await dispatchWake(params, batch(), { rearmGeneration: 1, batchRunIds });
        transport();
        await params.completeBatch(batch(), 1, delivered(), finalized);
        return true;
      });
      try {
        await run();
        for (let event = 0; event <= failures; event += 1) {
          if (settlementWrites > failures) {
            break;
          }
          expect(transport).toHaveBeenCalledOnce();
          expect(finalized).not.toHaveBeenCalled();
          for (const input of inputs) {
            const stored = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
            expect(stored).toMatchObject({
              delivery: { status: "in_progress" },
              requesterSettleWake: { rearmGeneration: 1, batchRunIds },
            });
          }
          // No child changes again; the existing sweep must adopt the retained receipt.
          await sweep();
        }
        expect(settlementWrites).toBe(failures + 1);
        expect(warn).toHaveBeenCalledWith(
          "requester settle wake failed",
          expect.objectContaining({
            error: expect.objectContaining({
              message: expect.stringContaining("delivered outcome persistence unavailable"),
            }),
          }),
        );
        expect(transport).toHaveBeenCalledOnce();
        expect(finalized).toHaveBeenCalledOnce();
        for (const input of inputs) {
          const stored = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
          expect(stored?.delivery).toMatchObject({ status: "delivered", deliveredAt: 5_000 });
          expect(stored?.requesterSettleWake).toBeUndefined();
        }
      } finally {
        database.db.exec("DROP TRIGGER IF EXISTS reject_delivered_batch");
        controller.clearRuntimeState();
        worker.mockRestore();
      }
    }),
);

it("recovers a failed replay publication through the existing sweep", () =>
  withSubagentCompletionWorkerState(async (database) => {
    const { input, controller, wake, run, sweep, current, stored } = createWakeFixture(database);
    const attempts = vi.fn();
    const batchRunIds = [input.subagent.runId];
    const pending = {
      ...structuredClone(input.subagent.requesterSettleWake!),
      nextAttemptAt: Date.now() + 30_000,
    };
    database.db.exec(
      "CREATE TRIGGER reject_wake_publication BEFORE UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.requesterSettleWake.status') = 'pending' BEGIN SELECT RAISE(ABORT, 'wake publication unavailable'); END",
    );
    wake.mockImplementation(async (params) => {
      await dispatchWake(params, [current()], { ...pending, batchRunIds });
      attempts();
      if (attempts.mock.calls.length === 1) {
        await params.transitionBatch([current()], pending, () => {});
        return false;
      }
      await params.completeBatch([current()], pending.rearmGeneration, delivered());
      return true;
    });
    try {
      await run();
      expect(attempts).toHaveBeenCalledOnce();
      expect(stored()?.requesterSettleWake).toBeDefined();
      database.db.exec("DROP TRIGGER reject_wake_publication");
      await sweep();
      expect(attempts).toHaveBeenCalledTimes(2);
      expect(wake).toHaveBeenCalledTimes(2);
      expect(stored()?.requesterSettleWake).toBeUndefined();
      expect(stored()?.delivery?.status).toBe("delivered");
    } finally {
      database.db.exec("DROP TRIGGER IF EXISTS reject_wake_publication");
      controller.clearRuntimeState();
    }
  }));

it("does not settle a new wake generation with a retained prior outcome", () =>
  withSubagentCompletionWorkerState(async (database) => {
    const { input, controller, wake, run, current, stored } = createWakeFixture(database);
    const transport = vi.fn();
    const finalized = vi.fn();
    wake.mockImplementation(async (params) => {
      const generation = params.settledEntry.requesterSettleWake?.rearmGeneration;
      await dispatchWake(params, [params.settledEntry], {
        rearmGeneration: generation,
        batchRunIds: [input.subagent.runId],
      });
      transport(generation);
      await params.completeBatch(
        [current()],
        generation,
        delivered(generation === 1 ? 5_000 : 6_000),
        () => finalized(generation),
      );
      return true;
    });
    database.db.exec(
      "CREATE TRIGGER reject_old_outcome BEFORE UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.delivery.status') = 'delivered' BEGIN SELECT RAISE(ABORT, 'old outcome persistence unavailable'); END",
    );
    try {
      await run();
      expect(transport.mock.calls).toEqual([[1]]);
      expect(finalized).not.toHaveBeenCalled();
      database.db.exec("DROP TRIGGER reject_old_outcome");
      await updateRun(input, (next) => {
        next.requesterSettleWake = {
          status: "pending",
          attemptCount: 0,
          rearmGeneration: 2,
          batchRunIds: [next.runId],
        };
        next.delivery = { status: "pending", generation: 2 };
      });
      await run(current());
      expect(transport.mock.calls).toEqual([[1], [2]]);
      expect(finalized.mock.calls).toEqual([[2]]);
      const persisted = stored();
      expect(persisted?.delivery).toMatchObject({
        status: "delivered",
        generation: 2,
        deliveredAt: 6_000,
      });
      expect(persisted?.requesterSettleWake).toBeUndefined();
    } finally {
      database.db.exec("DROP TRIGGER IF EXISTS reject_old_outcome");
      controller.clearRuntimeState();
    }
  }));
