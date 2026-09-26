import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { loadPendingFinalDeliveryPayload } from "../registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "../registry/subagent-registry-state.js";
import { bindSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import { upsertSubagentRunRowInDatabase } from "../registry/subagent-registry.store.kernel.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import {
  blockSubagentCompletionDelivery,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.store.js";
import {
  advanceRequesterWakeTime,
  armRequesterWake,
  failedRecords,
  records,
  requesterWakeDriver,
  admitCompletionFixtureDatabase,
  seedSubagentCompletionDelivery,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("persisted subagent requester wakes", () => {
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    const tempDir = tempDirs.make("openclaw-subagent-wake-", resolvePreferredOpenClawTmpDir());
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
    await admitCompletionFixtureDatabase();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function persistOwner(input: ReturnType<typeof records>) {
    seedSubagentCompletionDelivery({
      subagent: input.subagent,

      databaseOptions: { database },
    });
    subagentRuns.set(input.subagent.runId, input.subagent);
  }

  function systemEvents() {
    return database.db
      .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
      .all();
  }

  async function reopenOwners() {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    database = openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
  }

  it.each([true, false])(
    "keeps active cleanup unless requester delivery is blocked (delivered=%s)",
    async (delivered) => {
      const input = armRequesterWake(records());
      input.subagent.cleanupCompletedAt = undefined;
      persistOwner(input);
      const driver = requesterWakeDriver([input]);
      const generation = driver.controller.bumpCleanupGeneration(input.subagent);

      await settleRequesterCompletionBatch({
        entries: [{ subagent: input.subagent }],
        outcome: {
          delivered,
          path: "direct",
          error: delivered ? undefined : "requester unavailable",
        },
        isCurrent: () => true,
        databaseOptions: { database },
      });

      expect(
        driver.controller.isCleanupAttemptCurrent(input.subagent.runId, input.subagent, generation),
      ).toBe(delivered);
      expect(input.subagent.requesterSettleWake).toBeUndefined();
      expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.cleanupHandled).toBe(
        false,
      );
    },
  );

  it("settles a rejected dispatch transition after rollback without another wake", async () => {
    const input = armRequesterWake(records());
    persistOwner(input);
    const driver = requesterWakeDriver([input]);
    vi.spyOn(driver.controller.options, "persistOrThrow").mockImplementationOnce(() => {
      throw new Error("dispatch write failed");
    });
    driver.wake.mockImplementation(async (params) => {
      await params.transitionBatch([input.subagent], {
        status: "dispatching",
        attemptCount: 1,
        rearmGeneration: 1,
      });
      throw new Error("transport must not start");
    });
    try {
      await driver.run();
      expect(input.subagent.requesterSettleWake).toBeUndefined();
      expect(input.subagent.delivery).toMatchObject({
        status: "failed",
        lastError: "dispatch write failed",
      });
      await reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(driver.wake).toHaveBeenCalledOnce();
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it.each(["second owner", "second run write", "retirement"] as const)(
    "commits the entire requester batch or nothing when %s refuses settlement",
    async (cut) => {
      const first = records();
      const second = records();
      second.subagent.runId = "completion-second";
      second.subagent.childSessionKey = "agent:main:subagent:second";
      const inputs = [first, second];
      const ids = inputs.map(({ subagent }) => subagent.runId);
      for (const input of inputs) {
        armRequesterWake(input, ids);
        if (cut === "retirement") {
          input.subagent.requesterSettleWake!.retireAfterSettle = true;
        }
        persistOwner(input);
      }
      const liveBefore = inputs.map(({ subagent }) => structuredClone(subagent));
      if (cut === "second owner") {
        const changed = structuredClone(second);
        changed.subagent.generation = (changed.subagent.generation ?? 0) + 1;
        seedSubagentCompletionDelivery({ ...changed, databaseOptions: { database } });
      } else {
        database.db.exec(
          cut === "second run write"
            ? "CREATE TRIGGER reject_batch AFTER UPDATE ON subagent_runs WHEN NEW.run_id = 'completion-second' BEGIN SELECT RAISE(ABORT, 'cut:second'); END"
            : "CREATE TRIGGER reject_batch AFTER DELETE ON subagent_runs WHEN OLD.run_id = 'completion-second' BEGIN SELECT RAISE(ABORT, 'cut:retirement'); END",
        );
      }
      const snapshot = () =>
        ["subagent_runs", "delivery_queue_entries"].map((table) =>
          database.db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all(),
        );
      const before = snapshot();
      const driver = requesterWakeDriver(inputs);
      let settle:
        | Parameters<typeof driver.controller.options.maybeWakeRequesterAfterAllChildrenSettled>[0]
        | undefined;
      driver.wake.mockImplementation(async (params) => {
        settle = params;
        return false;
      });
      const observed = vi.fn(() =>
        inputs.map(({ subagent }) =>
          structuredClone(subagentRuns.get(subagent.runId)?.requesterSettleWake),
        ),
      );
      const unsubscribe = onSubagentRegistryPersisted(observed);
      try {
        await driver.run();
        await expect(
          settle!.completeBatch(
            inputs.map(({ subagent }) => subagent),
            1,
            {
              delivered: false,
              path: "none",
              error: "requester unavailable",
            },
          ),
        ).rejects.toThrow();
        expect(inputs.map(({ subagent }) => subagent)).toEqual(liveBefore);
        expect(snapshot()).toEqual(before);
        expect(observed).not.toHaveBeenCalled();
        if (cut !== "second owner") {
          database.db.exec("DROP TRIGGER reject_batch");
        }
        await reopenOwners();
        expect(snapshot()).toEqual(before);
        for (const [index, input] of inputs.entries()) {
          input.subagent = subagentRuns.get(input.subagent.runId)!;
          if (cut === "second owner" && index === 1) {
            persistOwner(input);
          }
        }
        const retry = requesterWakeDriver(inputs);
        try {
          await retry.run();
          expect(observed).toHaveBeenCalledOnce();
          expect(observed.mock.results[0]?.value).toEqual([undefined, undefined]);
          expect(systemEvents()).toHaveLength(2);
          await reopenOwners();
          for (const input of inputs) {
            expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
            expect(subagentRuns.has(input.subagent.runId)).toBe(cut !== "retirement");
          }
        } finally {
          retry.controller.clearScheduledResumeTimers();
        }
      } finally {
        unsubscribe();
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each([false, true])(
    "reconciles failed replay persistence before transport (sibling rearmed: %s)",
    async (rearmSibling) => {
      vi.useFakeTimers();
      const input = armRequesterWake(records());
      const sibling = armRequesterWake(records());
      sibling.subagent.runId = "replay-sibling";
      sibling.subagent.childSessionKey = sibling.subagent.childSessionKey =
        "agent:main:subagent:replay-sibling";
      const inputs = rearmSibling ? [input, sibling] : [input];
      const batch = inputs.map(({ subagent }) => subagent);
      const batchRunIds = batch.map(({ runId }) => runId);
      for (const record of inputs) {
        armRequesterWake(record, batchRunIds);
        persistOwner(record);
      }
      const driver = requesterWakeDriver(inputs);
      const persist = driver.controller.options.persistOrThrow.bind(driver.controller.options);
      let unavailable = true;
      let writes = 0;
      driver.controller.options.persistOrThrow = (...ids) => {
        if (input.subagent.requesterSettleWake?.replayCount) {
          writes++;
          if (unavailable) {
            throw new Error("replay persistence unavailable");
          }
        }
        persist(...ids);
      };
      const transport = vi.fn();
      driver.wake.mockImplementation(async (params) => {
        const state = input.subagent.requesterSettleWake!;
        if (state.status !== "dispatching") {
          await params.transitionBatch(batch, {
            status: "dispatching",
            attemptCount: 1,
            rearmGeneration: 1,
            batchRunIds,
          });
        }
        transport();
        if (transport.mock.calls.length === 1) {
          await params.transitionBatch(batch, {
            status: "dispatching",
            attemptCount: 1,
            replayCount: 1,
            nextAttemptAt: Date.now() + 30_000,
            rearmGeneration: 1,
            batchRunIds,
            lastError: "ambiguous transport",
          });
        } else {
          expect(state).toMatchObject({ status: "dispatching", attemptCount: 1, replayCount: 1 });
          await params.completeBatch([input.subagent], 1, { delivered: true, path: "direct" });
        }
        return false;
      });
      try {
        await driver.run();
        if (rearmSibling) {
          sibling.subagent.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
            nextAttemptAt: Date.now() + 600_000,
          };
          persist(sibling.subagent.runId);
        }
        for (let sweep = 0; sweep < 6; sweep++) {
          await advanceRequesterWakeTime(5_000, () =>
            driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent),
          );
        }
        expect(transport).toHaveBeenCalledOnce();
        expect(writes).toBe(2);
        for (let sweep = 0; sweep < 6; sweep++) {
          await advanceRequesterWakeTime(5_000, () =>
            driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent),
          );
        }
        expect(transport).toHaveBeenCalledOnce();
        expect(writes).toBe(2);
        unavailable = false;
        await advanceRequesterWakeTime(30_000);
        expect(writes).toBe(3);
        expect(transport).toHaveBeenCalledOnce();
        await advanceRequesterWakeTime(0, () =>
          driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent),
        );
        expect(transport).toHaveBeenCalledTimes(2);
        expect(input.subagent.requesterSettleWake).toBeUndefined();
        expect(input.subagent.delivery?.status).toBe("delivered");
        if (rearmSibling) {
          expect(sibling.subagent.requesterSettleWake).toMatchObject({
            attemptCount: 0,
            rearmGeneration: 2,
          });
        }
      } finally {
        driver.controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["current", "replacement", "rearm"] as const)(
    "retains a known delivered outcome without redelivery or overwriting a %s owner",
    async (owner) => {
      vi.useFakeTimers();
      const input = armRequesterWake(records());
      input.subagent.requesterSettleWake!.status = "dispatching";
      input.subagent.requesterSettleWake!.attemptCount = 1;
      persistOwner(input);
      const driver = requesterWakeDriver([input]);
      const finalized = vi.fn();
      database.db.exec(
        "CREATE TRIGGER reject_delivered AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'cut:delivered'); END",
      );
      driver.wake.mockImplementation(async (params) => {
        await params.completeBatch(
          [input.subagent],
          1,
          {
            delivered: true,
            path: "direct",
            requesterVisibleFinalDelivered: true,
          },
          finalized,
        );
        return true;
      });
      try {
        await driver.run();
        expect(input.subagent.delivery?.status).toBe("in_progress");
        expect(finalized).not.toHaveBeenCalled();
        for (let sweep = 0; sweep < 6; sweep++) {
          await advanceRequesterWakeTime(5_000, () =>
            driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent),
          );
        }
        expect(driver.wake).toHaveBeenCalledOnce();
        database.db.exec("DROP TRIGGER reject_delivered");
        if (owner === "replacement") {
          const replacement = structuredClone(input.subagent);
          subagentRuns.set(replacement.runId, replacement);
        } else if (owner === "rearm") {
          input.subagent.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
          };
          driver.controller.options.persistOrThrow(input.subagent.runId);
        }
        // The next persistence deadline is independent of the failed durable write.
        await advanceRequesterWakeTime(60_000);
        if (owner === "current") {
          expect(driver.wake).toHaveBeenCalledOnce();
          expect(finalized).toHaveBeenCalledOnce();
          expect(input.subagent.requesterSettleWake).toBeUndefined();
          await reopenOwners();
        } else {
          expect(finalized).not.toHaveBeenCalled();
          expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("in_progress");
          if (owner === "rearm") {
            expect(input.subagent.requesterSettleWake?.rearmGeneration).toBe(2);
          }
        }
      } finally {
        driver.controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["in_progress", "delivered"] as const)(
    "replaces a %s completion receipt on requester settlement and clears pending payloads",
    async (status) => {
      const input = armRequesterWake(records());
      const receipt = input.subagent.delivery!;
      receipt.status = status;
      if (status === "in_progress") {
        receipt.payload = loadPendingFinalDeliveryPayload(input.subagent);
        receipt.attemptCount = 2;
      } else {
        receipt.deliveredAt = receipt.announcedAt = Date.now();
      }
      const before = structuredClone(receipt);
      persistOwner(input);
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        await params.completeBatch([input.subagent], 1, { delivered: true, path: "direct" });
        return true;
      });
      try {
        await driver.run();
        expect(input.subagent.delivery).not.toBe(receipt);
        expect(input.subagent.delivery?.status).toBe("delivered");
        expect(input.subagent.delivery?.payload).toBeUndefined();
        expect(input.subagent.delivery?.attemptCount).toBeUndefined();
        expect(receipt).toEqual(before);
        expect(input.subagent.requesterSettleWake).toBeUndefined();
        await reopenOwners();
        expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
          status: "delivered",
        });
        expect(subagentRuns.get(input.subagent.runId)?.delivery?.payload).toBeUndefined();
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each([
    { change: "rearmed", delivered: true },
    { change: "retired", delivered: true },
    { change: "replaced", delivered: true },
    { change: "not yet durable", delivered: true },
    { change: "blocked", delivered: true },
    { change: "blocked retirement", delivered: true },
    { change: "blocked newer wave", delivered: true },
    { change: "rearmed", delivered: false },
    { change: "retired", delivered: false },
  ] as const)(
    "retains the known outcome for unchanged siblings when one member is $change (delivered=$delivered)",
    async ({ change, delivered }) => {
      vi.useFakeTimers();
      const first = records();
      const second = records();
      second.subagent.runId = "completion-second";
      second.subagent.childSessionKey = "agent:main:subagent:second";
      const third = records();
      third.subagent.runId = "completion-third";
      third.subagent.childSessionKey = "agent:main:subagent:third";
      const inputs = [first, second, third];
      const ids = inputs.map(({ subagent }) => subagent.runId);
      for (const input of inputs) {
        armRequesterWake(input, ids);
        if (input === second && change === "blocked retirement") {
          input.subagent.requesterSettleWake!.retireAfterSettle = true;
        }
        input.subagent.requesterSettleWake!.status = "dispatching";
        input.subagent.requesterSettleWake!.attemptCount = 1;
        persistOwner(input);
      }
      const driver = requesterWakeDriver(inputs);
      const finalized = vi.fn();
      driver.wake.mockImplementation(async (params) => {
        await params.completeBatch(
          inputs.map(({ subagent }) => subagent),
          1,
          {
            delivered,
            path: "direct",
            requesterVisibleFinalDelivered: delivered ? true : undefined,
            error: delivered ? undefined : "requester unavailable",
          },
          finalized,
        );
        return true;
      });
      database.db.exec(
        "CREATE TRIGGER reject_outcome AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'cut:outcome'); END",
      );
      try {
        await driver.run();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(finalized).not.toHaveBeenCalled();
        database.db.exec("DROP TRIGGER reject_outcome");
        const blocked = change.startsWith("blocked");
        if (blocked) {
          expect(
            await blockSubagentCompletionDelivery({
              subagent: second.subagent,

              reason: "B was independently closed",
              databaseOptions: { database },
            }),
          ).toBe(true);
          expect(second.subagent.requesterSettleWake?.rearmGeneration).toBe(1);
        }
        let successor = second.subagent;
        if (change === "retired") {
          subagentRuns.delete(second.subagent.runId);
          driver.controller.options.persistOrThrow(second.subagent.runId);
        } else if (!blocked || change === "blocked newer wave") {
          if (change === "replaced") {
            successor = structuredClone(second.subagent);
            successor.generation = (successor.generation ?? 0) + 1;
            subagentRuns.set(successor.runId, successor);
          }
          successor.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
            batchRunIds: [successor.runId],
            nextAttemptAt: Date.now() + 600_000,
          };
          if (change !== "not yet durable") {
            driver.controller.options.persistOrThrow(successor.runId);
          }
        }
        const newerWake = structuredClone(successor.requesterSettleWake);
        await advanceRequesterWakeTime(30_000, () =>
          driver.controller.resumeRequesterSettleWake(first.subagent.runId, first.subagent),
        );
        expect(driver.wake).toHaveBeenCalledOnce();
        if (change === "not yet durable") {
          // The store still sees B as an old-cohort owner: retain A's fence rather
          // than omitting B or treating refusal as permission for another send.
          expect(first.subagent.requesterSettleWake).toBeDefined();
          expect(first.subagent.delivery?.status).toBe("in_progress");
          expect(finalized).not.toHaveBeenCalled();
          driver.controller.options.persistOrThrow(successor.runId);
          await advanceRequesterWakeTime(60_000);
        }
        expect(driver.wake).toHaveBeenCalledOnce();
        for (const input of [first, third]) {
          expect(input.subagent.requesterSettleWake).toBeUndefined();
          expect(input.subagent.delivery?.status).toBe(delivered ? "delivered" : "failed");
        }
        expect(finalized).toHaveBeenCalledOnce();
        if (change !== "retired" && change !== "blocked retirement") {
          expect(subagentRuns.get(successor.runId)).toBe(successor);
          expect(successor.requesterSettleWake).toEqual(
            change === "blocked" ? undefined : newerWake,
          );
          expect(successor.delivery?.status).toBe(blocked ? "failed" : "in_progress");
        } else {
          expect(subagentRuns.has(second.subagent.runId)).toBe(false);
        }
        await reopenOwners();
        for (const input of [first, third]) {
          expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
        }
        expect(subagentRuns.get(second.subagent.runId)?.requesterSettleWake).toEqual(
          ["retired", "blocked", "blocked retirement"].includes(change) ? undefined : newerWake,
        );
        expect(systemEvents()).toHaveLength((blocked ? 1 : 0) + (delivered ? 0 : 2));
      } finally {
        driver.controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { status: "failed", outcome: { status: "error" } },
    { status: "timed_out", outcome: { status: "timeout" } },
  ] as const)(
    "settles an uncaptured $status wake without inventing reply capture",
    async ({ status, outcome }) => {
      const input = failedRecords(status, outcome);
      input.subagent.completion = { required: true };
      persistOwner(input);
      const before = structuredClone(input);
      const driver = requesterWakeDriver([input]);
      try {
        await driver.run();
        expect(driver.warn).not.toHaveBeenCalledWith(
          "failed to persist requester settle wake rejection",
          expect.any(Object),
        );
        await reopenOwners();
        const restored = subagentRuns.get(input.subagent.runId)!;
        expect(restored.requesterSettleWake).toBeUndefined();
        expect(restored.execution).toEqual(before.subagent.execution);
        expect(restored.completion).toEqual(before.subagent.completion);
        expect(systemEvents()).toEqual([]);
        expect(driver.wake).toHaveBeenCalledOnce();
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each(["missing outcome", "paused", "superseded generation"] as const)(
    "does not settle uncaptured completion with %s evidence",
    async (change) => {
      const input = failedRecords("failed", { status: "error" });
      input.subagent.completion = { required: true };
      if (change === "missing outcome") {
        input.subagent.execution.outcome = undefined;
      } else if (change === "paused") {
        input.subagent.pauseReason = "sessions_yield";
      }
      persistOwner(input);
      const before = structuredClone(input);
      if (change === "superseded generation") {
        before.subagent.delivery!.generation = 2;
        upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(before.subagent));
      }
      expect(
        await blockSubagentCompletionDelivery({
          subagent: input.subagent,

          reason: "requester unavailable",
        }),
      ).toBe(false);
      await reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)).toEqual(before.subagent);
      expect(systemEvents()).toEqual([]);
    },
  );

  it.each([
    { delivered: false, retireAfterSettle: false },
    { delivered: false, retireAfterSettle: true },
    { delivered: true, retireAfterSettle: false },
    { delivered: true, retireAfterSettle: true },
  ])(
    "settles a yielded requester wake without completing the paused task (delivered=$delivered, retire=$retireAfterSettle)",
    async ({ delivered, retireAfterSettle }) => {
      const input = armRequesterWake(records());
      input.subagent.pauseReason = "sessions_yield";
      input.subagent.execution.outcome = undefined;
      input.subagent.completion = { required: true };
      input.subagent.delivery = { status: "pending" };
      input.subagent.cleanupCompletedAt = undefined;
      input.subagent.cleanupHandled = false;
      input.subagent.requesterSettleWake!.retireAfterSettle = retireAfterSettle;
      persistOwner(input);
      const before = structuredClone(input);
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        await params.completeBatch([params.settledEntry], 1, {
          delivered,
          path: "direct",
          error: delivered ? undefined : "requester unavailable",
        });
        return delivered;
      });
      try {
        await driver.run();
        expect(driver.warn).not.toHaveBeenCalledWith(
          "failed to persist requester settle wake rejection",
          expect.any(Object),
        );
        await reopenOwners();
        expect(subagentRuns.get(input.subagent.runId)).toEqual({
          ...before.subagent,
          requesterSettleWake: undefined,
        });
        expect(systemEvents()).toEqual([]);
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each(["unchanged", "newer sibling", "run generation", "wake generation"])(
    "reconciles a retired cancellation wake only with its current owner: %s",
    async (change) => {
      const input = failedRecords("cancelled", { status: "error", error: "stopped" });
      const endedAt = Date.now() - 9 * 24 * 60 * 60_000;
      input.subagent.execution.endedAt = endedAt;
      input.subagent.cleanupCompletedAt = endedAt;
      input.subagent.completion = { required: true };
      input.subagent.delivery = { status: "pending" };
      persistOwner(input);
      await reopenOwners();
      input.subagent = subagentRuns.get(input.subagent.runId)!;
      const before = structuredClone(input.subagent);
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async () => {
        if (change !== "unchanged") {
          const updated = structuredClone(input.subagent);
          if (change === "newer sibling") {
            updated.runId = "newer-child-run";
            updated.generation = (updated.generation ?? 0) + 1;
          } else if (change === "run generation") {
            updated.generation = (updated.generation ?? 0) + 1;
          } else {
            updated.requesterSettleWake!.rearmGeneration = 2;
          }
          upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(updated));
        }
        throw new Error("requester unavailable");
      });
      try {
        await driver.run();
        if (change === "unchanged") {
          expect(driver.warn).not.toHaveBeenCalledWith(
            "failed to persist requester settle wake rejection",
            expect.any(Object),
          );
        } else {
          expect(driver.warn).toHaveBeenCalledWith(
            "failed to persist requester settle wake rejection",
            expect.any(Object),
          );
        }
        await reopenOwners();
        const restored = subagentRuns.get(input.subagent.runId)!;
        expect(restored.execution).toEqual(before.execution);
        expect(restored.cleanupCompletedAt).toBe(endedAt);
        if (change === "unchanged") {
          expect(restored.requesterSettleWake).toBeUndefined();
          expect(restored.completion).toEqual({
            required: true,
            resultText: null,
            capturedAt: endedAt,
          });
          expect(restored.delivery).toMatchObject({
            status: "failed",
            lastError: "requester unavailable",
          });
          expect(restored.suppressCompletionDelivery).toBe(true);
        } else {
          expect(restored.requesterSettleWake).toBeDefined();
          expect(restored.completion).toEqual(before.completion);
          expect(restored.delivery).toEqual(before.delivery);
        }
        expect(database.db.prepare("SELECT COUNT(*) AS count FROM task_runs").get()?.count).toBe(0);
        expect(systemEvents()).toEqual([]);
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each(["not_required", "discarded"] as const)(
    "retains a frozen wake and source-owned %s disposition across rejected commits",
    async (status) => {
      const input = armRequesterWake(records());
      input.subagent.suppressCompletionDelivery = true;
      input.subagent.delivery = { status, disposition: "intentional_non_delivery", generation: 1 };
      input.subagent.requesterSettleWake!.requesterYieldBatch = true;
      persistOwner(input);
      const before = structuredClone(input.subagent);
      const settle = () =>
        settleRequesterCompletionBatch({
          entries: [{ subagent: input.subagent }],
          outcome: { delivered: true, path: "direct" },
          isCurrent: () => true,
          databaseOptions: { database },
        });
      database.db.exec(
        "CREATE TRIGGER reject_closed_wake AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'temporary closed-wake write failure'); END",
      );
      try {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await expect(settle()).rejects.toThrow("temporary closed-wake write failure");
          expect(input.subagent).toEqual(before);
          expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toMatchObject({
            delivery: before.delivery,
            requesterSettleWake: before.requesterSettleWake,
            suppressCompletionDelivery: true,
          });
        }
      } finally {
        database.db.exec("DROP TRIGGER reject_closed_wake");
      }
      await settle();
      expect(input.subagent.delivery).toEqual(before.delivery);
      expect(input.subagent.completion).toEqual(before.completion);
      expect(input.subagent.suppressCompletionDelivery).toBe(true);
      expect(input.subagent.requesterSettleWake).toBeUndefined();
      expect(systemEvents()).toEqual([]);
    },
  );
});
