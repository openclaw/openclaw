import path from "node:path";
import { aroundEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../../sessions/session-controller.context.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
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
type Wake = Parameters<ReturnType<typeof requesterWakeDriver>["wake"]>[0];
const completeWake = (params: Wake, finalized?: () => void) =>
  params.completeBatch(
    [params.settledEntry],
    params.settledEntry.requesterSettleWake?.rearmGeneration,
    undefined,
    finalized,
  );

function changeRun(
  input: ReturnType<typeof records>,
  change: (run: ReturnType<typeof records>["subagent"]) => void,
) {
  return mutateSubagentRuns([input.subagent.runId], (rows) => {
    const next = structuredClone(rows.get(input.subagent.runId)!);
    change(next);
    return { value: undefined, postimages: new Map([[next.runId, next]]) };
  });
}
function seedDriver(
  database: Parameters<Parameters<typeof withSubagentCompletionWorkerState>[0]>[0],
  input: ReturnType<typeof records>,
) {
  seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
  return requesterWakeDriver([input]);
}

describe("requester settle retry lifetime", () => {
  let database: Parameters<typeof seedDriver>[0];
  aroundEach((runTest) =>
    withSubagentCompletionWorkerState(async (state) => {
      database = state;
      await runTest();
    }),
  );
  it.each(["same", "other", "unbound"] as const)(
    "suppresses a stop notification only for its physically admitted requester (%s store)",
    async (store) => {
      const input = armRequesterWake(records());
      const stateDir = path.dirname(database.path);
      const logicalStore = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const physicalStore = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
      input.subagent.requesterStorePath =
        store === "unbound" ? undefined : physicalStore + (store === "other" ? ".other" : "");
      using driver = seedDriver(database, input);
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
      }
    },
  );

  it.each([false, true])(
    "finishes a wake after its originating tool caller expires (restored=%s)",
    async (restored) => {
      const input = armRequesterWake(records());
      using driver = seedDriver(database, input);
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
        await completeWake(params);
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
      }
    },
  );

  it.each(["before scheduling", "while waiting for recovery capacity"] as const)(
    "defers a stopped pause notice until obligation retirement: %s",
    async (stopAt) => {
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
      using driver = seedDriver(database, input);
      const releaseCapacity = createDeferred();
      let capacity: Promise<unknown>[] = [];
      const observedNotices: unknown[] = [];
      driver.wake.mockImplementation(async (params) => {
        observedNotices.push(params.settledEntry.requesterSettleWake?.pauseNotice);
        await completeWake(params);
        return true;
      });
      const stop = () =>
        changeRun(input, (next) => {
          next.pauseReason = undefined;
          next.endedReason = "subagent-killed";
          next.execution.outcome = { status: "error", error: "subagent run terminated" };
        });
      const drainScheduled = observeRootWork();
      try {
        if (stopAt === "before scheduling") {
          await stop();
        } else {
          driver.controller.markRequesterSettleWakeRestored(input.subagent);
          const slots = [createDeferred(), createDeferred()];
          capacity = slots.map((entered) =>
            driver.controller.runBackgroundWork(input.subagent, async () => {
              entered.resolve();
              await releaseCapacity.promise;
            }),
          );
          await awaitGateBeforeSettlement(
            Promise.all(slots.map((slot) => slot.promise)),
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
          await driver.controller.retireSubagentObligations(currentCompletionRun(input), () => {});
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
      }
    },
  );

  it.each(["during read", "after wait", "deadline", "retired active", "retired deadline"] as const)(
    "handles descendant wait continuation or retirement: %s",
    async (trigger) => {
      resetGatewayWorkAdmission();
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const input = armRequesterWake(records());
      input.subagent.requesterSettleWake!.nextAttemptAt =
        trigger === "deadline" ? 5_000 : undefined;
      if (trigger.startsWith("retired")) {
        input.subagent.requesterSettleWake!.requesterYieldBatch = true;
      }
      const driver = seedDriver(database, input);
      const initial = structuredClone(currentCompletionRun(input).requesterSettleWake);
      const reading = createDeferred();
      const finishRead = createDeferred();
      const notify = () =>
        scheduleRequesterSettleWake(
          driver.controller,
          input.subagent.runId,
          currentCompletionRun(input),
        );
      driver.wake.mockImplementation(async (params) => {
        if (driver.wake.mock.calls.length === 1) {
          reading.resolve();
          if (trigger === "during read") {
            await finishRead.promise;
          }
          params.onDescendantsPending?.(trigger.endsWith("deadline") ? 310_000 : undefined);
          return false;
        }
        await params.completeBatch([params.settledEntry], 1);
        return true;
      });
      const first = driver.run();
      try {
        if (trigger === "during read") {
          await reading.promise;
          notify();
          finishRead.resolve();
        }
        await first;
        if (trigger.startsWith("retired")) {
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
          return;
        }
        if (trigger !== "during read") {
          expect(driver.wake).toHaveBeenCalledOnce();
          for (let sweep = 0; sweep < 5; sweep++) {
            await driver.run();
            await vi.advanceTimersByTimeAsync(30_000);
          }
          expect(driver.wake).toHaveBeenCalledOnce();
          expect(storedWake(input)).toEqual(initial);
          if (trigger === "after wait") {
            notify();
          } else {
            await vi.advanceTimersByTimeAsync(150_000);
          }
        }
        await vi.waitFor(() => {
          expect(driver.wake).toHaveBeenCalledTimes(2);
          expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
        });
      } finally {
        finishRead.resolve();
        await first;
        driver.controller.clearRuntimeState();
        vi.useRealTimers();
        resetGatewayWorkAdmission();
      }
    },
  );

  it.each(["replacement entry", "rejected completion"] as const)(
    "preserves retry ownership after the originating scope drains: %s",
    async (mode) => {
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
        await completeWake(params, finalized);
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
          await changeRun(input, (next) => {
            next.generation = (next.generation ?? 0) + 1;
          });
        }
        const replacement = currentCompletionRun(input);
        if (mode === "rejected completion") {
          database.db.exec(
            "CREATE TRIGGER reject_quiet_wake BEFORE UPDATE ON subagent_runs WHEN json_type(NEW.payload_json, '$.requesterSettleWake') IS NULL BEGIN SELECT RAISE(ABORT, 'no-wake persistence unavailable'); END",
          );
        }
        await driver.run(input.subagent);
        if (mode === "replacement entry") {
          expect(driver.wake).toHaveBeenCalledOnce();
          expect(currentCompletionRun(input)).toBe(replacement);
          expect(storedWake(input)).toEqual(owedWake);
          expect(driver.warn).not.toHaveBeenCalled();
        } else {
          expect(driver.wake).toHaveBeenCalledTimes(2);
          expect(wakeSignals[1]).toBeDefined();
          expect(wakeSignals[1]).not.toBe(origin.signal);
          expect(storedWake(input)).toEqual(owedWake);
          expect(currentCompletionRun(input).delivery).toEqual(deliveryBeforeCompletion);
          expect(finalized).not.toHaveBeenCalled();
          database.db.exec("DROP TRIGGER reject_quiet_wake");
          await driver.sweep();
          expect(driver.wake).toHaveBeenCalledTimes(2);
          expect(driver.warn).toHaveBeenCalled();
          expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
          expect(storedWake(input)).toBeUndefined();
          expect(finalized).toHaveBeenCalledOnce();
        }
      } finally {
        database.db.exec("DROP TRIGGER IF EXISTS reject_quiet_wake");
        driver.controller.clearRuntimeState();
        await origin.drain();
        resetGatewayWorkAdmission();
      }
    },
  );

  it("retains a delivered batch through repeated persistence failures without redelivery", async () => {
    const first = records();
    const sibling = records();
    sibling.subagent.runId = "retry-sibling";
    sibling.subagent.childSessionKey = "agent:main:subagent:retry-sibling";
    const inputs = [first, sibling];
    const batchRunIds = inputs.map(({ subagent }) => subagent.runId);
    for (const input of inputs) {
      armRequesterWake(input, batchRunIds);
      input.subagent.requesterSettleWake!.rearmGeneration = 2;
      input.subagent.delivery!.generation = 2;
      seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
    }
    using driver = requesterWakeDriver(inputs);
    const transport = vi.fn();
    const finalized = vi.fn();
    database.db.exec(
      "CREATE TRIGGER reject_delivered_batch BEFORE UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.delivery.status') = 'delivered' BEGIN SELECT RAISE(ABORT, 'delivered outcome persistence unavailable'); END",
    );
    driver.wake.mockImplementation(async (params) => {
      const batch = () => inputs.map((input) => currentCompletionRun(input));
      await params.transitionBatch(
        batch(),
        { status: "dispatching", attemptCount: 1, rearmGeneration: 2, batchRunIds },
        () => {},
      );
      transport();
      await params.completeBatch(
        batch(),
        2,
        { delivered: true, path: "direct", deliveredAt: 5_000 },
        finalized,
      );
      return true;
    });
    try {
      await driver.run();
      for (let event = 0; event < 4; event += 1) {
        expect(transport).toHaveBeenCalledOnce();
        expect(finalized).not.toHaveBeenCalled();
        for (const input of inputs) {
          const stored = storedRun(input);
          expect(stored?.delivery?.status).toBe("in_progress");
          expect(stored?.requesterSettleWake).toMatchObject({
            rearmGeneration: 2,
            batchRunIds,
          });
        }
        // No child changes again; the existing sweep must adopt the retained receipt.
        await driver.sweep();
      }
      database.db.exec("DROP TRIGGER reject_delivered_batch");
      await driver.sweep();
      expect(driver.warn).toHaveBeenCalled();
      expect(transport).toHaveBeenCalledOnce();
      expect(finalized).toHaveBeenCalledOnce();
      for (const input of inputs) {
        const stored = storedRun(input);
        expect(stored?.delivery).toMatchObject({
          status: "delivered",
          generation: 2,
          deliveredAt: 5_000,
        });
        expect(stored?.requesterSettleWake).toBeUndefined();
      }
    } finally {
      database.db.exec("DROP TRIGGER IF EXISTS reject_delivered_batch");
    }
  });
});
