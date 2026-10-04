import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { loadPendingFinalDeliveryPayload } from "../registry/subagent-delivery-state.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { getPendingWakeCommit } from "../registry/subagent-registry-requester-wake-commit.js";
import { bindSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../registry/subagent-registry.store.kernel.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  blockSubagentCompletionDelivery,
  mutateRequesterSettleWakeBatch,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.store.js";
import {
  currentCompletionRun,
  advanceRequesterWakeTime,
  armRequesterWake,
  reopenCompletionFixtureOwners,
  failedRecords,
  records,
  requesterWakeDriver,
  observeRequesterOutcomePublication,
  admitCompletionFixtureDatabase,
  seedSubagentCompletionDelivery,
  seedSubagentCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";
import { mutateSubagentCompletionInDatabase } from "./subagent-completion-mutation.kernel.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

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

  const persistOwner = (input: ReturnType<typeof records>) =>
    seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });

  function systemEvents() {
    return database.db
      .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
      .all();
  }

  it("reconciles an acknowledged retirement without even a no-op data write", async () => {
    const input = armRequesterWake(records());
    input.subagent.expectsCompletionMessage = false;
    input.subagent.delivery = { status: "not_required" };
    input.subagent.requesterSettleWake!.retireAfterSettle = true;
    persistOwner(input);
    let committed: RequesterWakeCommittedWrite | undefined;
    await expect(
      mutateRequesterSettleWakeBatch({
        entries: [input.subagent],
        operation: { kind: "complete" },
        context: captureOpenClawStateWorkerContext(),
        assertCurrent() {
          if (subagentRuns.get(input.subagent.runId) !== input.subagent) {
            throw new Error("Retirement lost its exact registered owner");
          }
        },
        onCommitted: (receipt) => {
          committed = receipt;
        },
        onPublished: () => {},
      }),
    ).resolves.toEqual({ applied: true, publication: "published" });
    if (!committed) {
      throw new Error("Retirement did not return its native receipt");
    }
    const receipt = committed;
    expect(loadSubagentRegistryFromSqlite().has(input.subagent.runId)).toBe(false);
    runOpenClawStateWriteTransaction(
      () => {
        const sql = observeHostDataSql();
        try {
          const result = mutateSubagentCompletionInDatabase(database, {
            kind: "requesterWake",
            entries: receipt.entries,
            operation: { kind: "complete" },
            committed: receipt,
          });
          expect(result).toMatchObject({ applied: true, retiredRunIds: [input.subagent.runId] });
          const isSelectedRead = (query: string) =>
            /^\s*select\b/i.test(query) && query.includes("subagent_runs");
          const selectedPreparations = sql.calls[0]!.mock.calls.filter(
            ([query]) => typeof query === "string" && isSelectedRead(query),
          ).length;
          // Count actual executions beyond prepares of these same SELECTs, including cached reads.
          expect(sql.queries.filter(isSelectedRead).length).toBeGreaterThan(selectedPreparations);
          expect(
            sql.queries.filter((query) => /^\s*(?:insert|update|delete)\b/i.test(query)),
          ).toEqual([]);
        } finally {
          sql.restore();
        }
      },
      { database, path: database.path },
    );
    expect(loadSubagentRegistryFromSqlite().has(input.subagent.runId)).toBe(false);
  });

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
      expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
      expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.cleanupHandled).toBe(
        false,
      );
    },
  );

  it("settles a rejected dispatch transition after rollback without another wake", async () => {
    const input = armRequesterWake(records());
    persistOwner(input);
    const driver = requesterWakeDriver([input]);
    database.db.exec(
      "CREATE TRIGGER reject_dispatch BEFORE UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.requesterSettleWake.status') = 'dispatching' BEGIN SELECT RAISE(ABORT, 'dispatch write failed'); END",
    );
    driver.wake.mockImplementation(async (params) => {
      await params.transitionBatch(
        [input.subagent],
        { status: "dispatching", attemptCount: 1, rearmGeneration: 1 },
        () => {},
      );
      throw new Error("transport must not start");
    });
    try {
      await driver.run();
      expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
      expect(currentCompletionRun(input).delivery).toMatchObject({
        status: "failed",
        lastError: expect.stringContaining("dispatch write failed"),
      });
      database.db.exec("DROP TRIGGER reject_dispatch");
      database = await reopenCompletionFixtureOwners();
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      expect(driver.wake).toHaveBeenCalledOnce();
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("preserves newer same-generation progress before initial wake transition admission", async () => {
    vi.useFakeTimers({ toNotFake: ["hrtime", "performance"] });
    const input = armRequesterWake(records());
    persistOwner(input);
    const driver = requesterWakeDriver([input]);
    const advancedWake = {
      ...input.subagent.requesterSettleWake!,
      status: "dispatching" as const,
      attemptCount: 2,
      replayCount: 1,
      nextAttemptAt: Date.now() + 30_000,
    };
    const published = vi.fn();
    driver.wake.mockImplementation(async (params) => {
      await mutateSubagentRuns([input.subagent.runId], (rows) => {
        const current = rows.get(input.subagent.runId)!;
        return {
          value: undefined,
          postimages: new Map([[current.runId, { ...current, requesterSettleWake: advancedWake }]]),
        };
      });
      await params.transitionBatch(
        [params.settledEntry],
        { ...input.subagent.requesterSettleWake!, status: "dispatching", attemptCount: 1 },
        published,
      );
      return false;
    });
    try {
      await driver.run();
      expect(published).not.toHaveBeenCalled();
      expect(currentCompletionRun(input).requesterSettleWake).toEqual(advancedWake);
      expect(
        loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.requesterSettleWake,
      ).toEqual(advancedWake);
      expect(driver.wake).toHaveBeenCalledOnce();
    } finally {
      driver.controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it.each(["second owner", "omitted sibling", "second run write", "retirement"] as const)(
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
      } else if (cut !== "omitted sibling") {
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
      const unsubscribe = subscribeSubagentRunChanges("persistence", observed);
      try {
        await driver.run();
        await expect(
          settle!.completeBatch(
            (cut === "omitted sibling" ? inputs.slice(0, 1) : inputs).map(
              ({ subagent }) => subagent,
            ),
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
        if (cut === "second owner") {
          expect(subagentRuns.get(second.subagent.runId)?.generation).toBe(
            (second.subagent.generation ?? 0) + 1,
          );
          observed.mockClear();
        } else {
          expect(observed).not.toHaveBeenCalled();
        }
        if (cut === "second run write" || cut === "retirement") {
          database.db.exec("DROP TRIGGER reject_batch");
        }
        database = await reopenCompletionFixtureOwners();
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
          database = await reopenCompletionFixtureOwners();
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
      sibling.subagent.childSessionKey = "agent:main:subagent:replay-sibling";
      const inputs = rearmSibling ? [input, sibling] : [input];
      const batch = inputs.map(({ subagent }) => subagent);
      const batchRunIds = batch.map(({ runId }) => runId);
      for (const record of inputs) {
        armRequesterWake(record, batchRunIds);
        persistOwner(record);
      }
      const driver = requesterWakeDriver(inputs);
      const completionStore = await import("./subagent-completion-admission.store.js");
      const mutate = completionStore.mutateRequesterSettleWakeBatch;
      let replayAttempts = 0;
      const observed = vi
        .spyOn(completionStore, "mutateRequesterSettleWakeBatch")
        .mockImplementation((params) => {
          if (
            params.operation.kind === "transition" &&
            params.operation.state.replayCount &&
            !params.committed
          ) {
            replayAttempts += 1;
          }
          return mutate(params);
        });
      database.db.exec(
        "CREATE TRIGGER reject_replay BEFORE UPDATE ON subagent_runs WHEN json_extract(NEW.payload_json, '$.requesterSettleWake.replayCount') = 1 BEGIN SELECT RAISE(ABORT, 'replay persistence unavailable'); END",
      );
      const transport = vi.fn();
      const acknowledgedBatches: string[][] = [];
      driver.wake.mockImplementation(async (params) => {
        const state = currentCompletionRun(input).requesterSettleWake!;
        let observedBatch = batch.map((entry) => subagentRuns.get(entry.runId)!);
        const adoptPublished = (published: readonly SubagentRunRecord[]) => {
          observedBatch = [...published];
          acknowledgedBatches.push(published.map((entry) => entry.runId));
        };
        if (state.status !== "dispatching") {
          await params.transitionBatch(
            observedBatch,
            { status: "dispatching", attemptCount: 1, rearmGeneration: 1, batchRunIds },
            adoptPublished,
          );
        }
        if (transport.mock.calls.length > 0) {
          expect(
            loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.requesterSettleWake,
          ).toMatchObject({ status: "dispatching", attemptCount: 1, replayCount: 1 });
        }
        transport();
        if (transport.mock.calls.length === 1) {
          await params.transitionBatch(
            observedBatch,
            {
              status: "dispatching",
              attemptCount: 1,
              replayCount: 1,
              nextAttemptAt: Date.now() + 30_000,
              rearmGeneration: 1,
              batchRunIds,
              lastError: "ambiguous transport",
            },
            adoptPublished,
          );
        } else {
          expect(state).toMatchObject({ status: "dispatching", attemptCount: 1, replayCount: 1 });
          await params.completeBatch([currentCompletionRun(input)], 1, {
            delivered: true,
            path: "direct",
          });
        }
        return false;
      });
      try {
        await driver.run();
        if (rearmSibling) {
          await mutateSubagentRuns([sibling.subagent.runId], (rows) => {
            const next = structuredClone(rows.get(sibling.subagent.runId)!);
            next.requesterSettleWake = {
              status: "pending",
              attemptCount: 0,
              rearmGeneration: 2,
              nextAttemptAt: Date.now() + 600_000,
            };
            return { value: undefined, postimages: new Map([[next.runId, next]]) };
          });
        }
        for (let sweep = 0; sweep < 6; sweep++) {
          await advanceRequesterWakeTime(5_000, () =>
            driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent),
          );
        }
        expect(transport).toHaveBeenCalledOnce();
        expect(replayAttempts).toBe(2);
        for (let sweep = 0; sweep < 6; sweep++) {
          await advanceRequesterWakeTime(5_000, () =>
            driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent),
          );
        }
        expect(transport).toHaveBeenCalledOnce();
        expect(replayAttempts).toBe(2);
        database.db.exec("DROP TRIGGER reject_replay");
        await advanceRequesterWakeTime(30_000);
        expect(replayAttempts).toBe(3);
        expect(transport).toHaveBeenCalledTimes(2);
        expect(acknowledgedBatches).toEqual([batchRunIds, [input.subagent.runId]]);
        await driver.wake.mock.results.at(-1)?.value;
        // A later sweep must not duplicate the continuation resumed after publication.
        await advanceRequesterWakeTime(0, () =>
          driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent),
        );
        expect(transport).toHaveBeenCalledTimes(2);
        expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
        expect(currentCompletionRun(input).delivery?.status).toBe("delivered");
        if (rearmSibling) {
          expect(currentCompletionRun(sibling).requesterSettleWake).toMatchObject({
            attemptCount: 0,
            rearmGeneration: 2,
          });
        }
      } finally {
        observed.mockRestore();
        database.db.exec("DROP TRIGGER IF EXISTS reject_replay");
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
        expect(currentCompletionRun(input).delivery?.status).toBe("in_progress");
        expect(finalized).not.toHaveBeenCalled();
        for (let sweep = 0; sweep < 6; sweep++) {
          await advanceRequesterWakeTime(5_000, () =>
            driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent),
          );
        }
        expect(driver.wake).toHaveBeenCalledOnce();
        database.db.exec("DROP TRIGGER reject_delivered");
        if (owner === "replacement") {
          const replacement = structuredClone(currentCompletionRun(input));
          replacement.generation = (replacement.generation ?? 0) + 1;
          await mutateSubagentRuns([replacement.runId], () => ({
            value: undefined,
            postimages: new Map([[replacement.runId, replacement]]),
          }));
        } else if (owner === "rearm") {
          await mutateSubagentRuns([input.subagent.runId], (rows) => {
            const next = structuredClone(rows.get(input.subagent.runId)!);
            next.requesterSettleWake = { status: "pending", attemptCount: 0, rearmGeneration: 2 };
            return { value: undefined, postimages: new Map([[next.runId, next]]) };
          });
        }
        // The next persistence deadline is independent of the failed durable write.
        await advanceRequesterWakeTime(60_000);
        if (owner === "current") {
          expect(driver.wake).toHaveBeenCalledOnce();
          expect(finalized).toHaveBeenCalledOnce();
          expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
          database = await reopenCompletionFixtureOwners();
        } else {
          expect(finalized).not.toHaveBeenCalled();
          expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("in_progress");
          if (owner === "rearm") {
            expect(currentCompletionRun(input).requesterSettleWake?.rearmGeneration).toBe(2);
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
        expect(currentCompletionRun(input).delivery).not.toBe(receipt);
        expect(currentCompletionRun(input).delivery?.status).toBe("delivered");
        expect(currentCompletionRun(input).delivery?.payload).toBeUndefined();
        expect(currentCompletionRun(input).delivery?.attemptCount).toBeUndefined();
        expect(receipt).toEqual(before);
        expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
        database = await reopenCompletionFixtureOwners();
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
    { change: "rearmed", delivered: true, cut: "rejected" },
    { change: "retired", delivered: true, cut: "rejected" },
    { change: "replaced", delivered: true, cut: "rejected" },
    { change: "blocked", delivered: true, cut: "rejected" },
    { change: "blocked retirement", delivered: true, cut: "rejected" },
    { change: "blocked newer wave", delivered: true, cut: "rejected" },
    { change: "rearmed", delivered: false, cut: "rejected" },
    { change: "retired", delivered: false, cut: "rejected" },
    { change: "rearmed", delivered: true, cut: "committed" },
    { change: "retired", delivered: true, cut: "committed" },
  ] as const)(
    "retains the known outcome for unchanged siblings when one member is $change (delivered=$delivered, cut=$cut)",
    async ({ change, delivered, cut }) => {
      vi.useFakeTimers();
      const originalStateDir = process.env.OPENCLAW_STATE_DIR!;
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
      const publication = await observeRequesterOutcomePublication(cut, originalStateDir);
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
      if (cut === "rejected") {
        database.db.exec(
          "CREATE TRIGGER reject_outcome AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'cut:outcome'); END",
        );
      }
      try {
        await driver.run();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(finalized).not.toHaveBeenCalled();
        if (cut === "committed") {
          expect(publication.retainedBeforePublication).toBe(true);
          process.env.OPENCLAW_STATE_DIR = originalStateDir;
          expect(loadSubagentRegistryFromSqlite().get(first.subagent.runId)?.delivery?.status).toBe(
            "delivered",
          );
          expect(currentCompletionRun(first).requesterSettleWake).toBeDefined();
        } else {
          database.db.exec("DROP TRIGGER reject_outcome");
        }
        const blocked = change.startsWith("blocked");
        if (blocked) {
          expect(
            await blockSubagentCompletionDelivery({
              subagent: second.subagent,

              reason: "B was independently closed",
              databaseOptions: { database },
            }),
          ).toBe(true);
          expect(currentCompletionRun(second).requesterSettleWake?.rearmGeneration).toBe(1);
        }
        const successor = structuredClone(currentCompletionRun(second));
        if (change === "retired") {
          await mutateSubagentRuns([second.subagent.runId], () => ({
            value: undefined,
            postimages: new Map([[second.subagent.runId, null]]),
          }));
        } else if (!blocked || change === "blocked newer wave") {
          if (change === "replaced") {
            successor.generation = (successor.generation ?? 0) + 1;
          }
          successor.requesterSettleWake = {
            status: "pending",
            attemptCount: 0,
            rearmGeneration: 2,
            batchRunIds: [successor.runId],
            nextAttemptAt: Date.now() + 600_000,
          };
          await mutateSubagentRuns([successor.runId], (rows) => {
            const next = {
              ...rows.get(successor.runId)!,
              generation: successor.generation,
              requesterSettleWake: successor.requesterSettleWake,
            };
            return { value: undefined, postimages: new Map([[successor.runId, next]]) };
          });
        }
        const newerWake = structuredClone(successor.requesterSettleWake);
        if (cut === "committed") {
          database.db.exec(
            "CREATE TRIGGER reject_outcome AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'committed outcome must not replay'); END",
          );
        }
        await advanceRequesterWakeTime(30_000, () =>
          driver.controller.resumeRequesterSettleWake(first.subagent.runId, first.subagent),
        );
        expect(driver.wake).toHaveBeenCalledOnce();
        for (const input of [first, third]) {
          expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
          expect(currentCompletionRun(input).delivery?.status).toBe(
            delivered ? "delivered" : "failed",
          );
        }
        expect(finalized).toHaveBeenCalledOnce();
        if (change !== "retired" && change !== "blocked retirement") {
          expect(currentCompletionRun({ subagent: successor }).requesterSettleWake).toEqual(
            change === "blocked" ? undefined : newerWake,
          );
          expect(currentCompletionRun({ subagent: successor }).delivery?.status).toBe(
            blocked ? "failed" : cut === "committed" ? "delivered" : "in_progress",
          );
        } else {
          expect(subagentRuns.has(second.subagent.runId)).toBe(false);
        }
        if (cut === "committed") {
          expect(
            getPendingWakeCommit(
              driver.controller,
              subagentRuns.get(second.subagent.runId) ?? second.subagent,
            ),
          ).toBeUndefined();
          expect(publication.reconciledBatches).toEqual([
            [first.subagent.runId, third.subagent.runId],
          ]);
          expect(driver.warn).not.toHaveBeenCalledWith(
            "failed to persist requester settle wake rejection",
            expect.any(Object),
          );
          database.db.exec("DROP TRIGGER reject_outcome");
        }
        database = await reopenCompletionFixtureOwners();
        for (const input of [first, third]) {
          expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
        }
        expect(subagentRuns.get(second.subagent.runId)?.requesterSettleWake).toEqual(
          ["retired", "blocked", "blocked retirement"].includes(change) ? undefined : newerWake,
        );
        expect(systemEvents()).toHaveLength((blocked ? 1 : 0) + (delivered ? 0 : 2));
      } finally {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
        publication.restore();
        database.db.exec("DROP TRIGGER IF EXISTS reject_outcome");
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
        database = await reopenCompletionFixtureOwners();
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
        writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(before.subagent)], []);
      }
      const blocked = blockSubagentCompletionDelivery({
        subagent: input.subagent,
        reason: "requester unavailable",
      });
      if (change === "superseded generation") {
        await expect(blocked).rejects.toThrow("delivery generation changed");
      } else {
        await expect(blocked).resolves.toBe(false);
      }
      database = await reopenCompletionFixtureOwners();
      expect(subagentRuns.get(input.subagent.runId)).toEqual(before.subagent);
      expect(systemEvents()).toEqual([]);
    },
  );

  it.each([false, true])(
    "settles a pause notice across reopen (store replaced=%s)",
    async (storeReplaced) => {
      const paused = records();
      const sibling = records();
      sibling.subagent.runId = "running-sibling";
      sibling.subagent.childSessionKey = "agent:main:subagent:sibling";
      sibling.subagent.execution = { status: "running", startedAt: Date.now() };
      const batchRunIds = [paused.subagent.runId, sibling.subagent.runId];
      for (const input of [paused, sibling]) {
        armRequesterWake(input, batchRunIds);
      }
      paused.subagent.pauseReason = "sessions_yield";
      paused.subagent.execution.outcome = undefined;
      paused.subagent.completion = { required: true };
      paused.subagent.delivery = { status: "pending" };
      paused.subagent.cleanupHandled = false;
      paused.subagent.cleanupCompletedAt = undefined;
      const completionWake = structuredClone(paused.subagent.requesterSettleWake);
      paused.subagent.requesterSettleWake!.pauseNotice = { acknowledgment: "Need a continuation." };
      for (const input of [paused, sibling]) {
        persistOwner(input);
      }
      const siblingBefore = structuredClone(sibling.subagent);

      await settleRequesterCompletionBatch({
        entries: [{ subagent: paused.subagent }],
        outcome: {
          delivered: !storeReplaced,
          path: "direct",
          ...(storeReplaced
            ? { storeReplaced: true, disposition: "intentional_non_delivery" as const }
            : {}),
        },
        isCurrent: () => true,
        databaseOptions: { database },
      });
      database = await reopenCompletionFixtureOwners();
      const restored = subagentRuns.get(paused.subagent.runId)!;
      expect(restored.requesterSettleWake).toEqual(storeReplaced ? undefined : completionWake);
      expect(restored.pauseReason).toBe("sessions_yield");
      expect(restored.execution.outcome).toBeUndefined();
      expect(restored.delivery).toEqual({ status: "pending" });
      expect(subagentRuns.get(sibling.subagent.runId)).toEqual(siblingBefore);
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
        database = await reopenCompletionFixtureOwners();
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

  it.each(["unchanged", "newer sibling", "run generation", "wake generation", "wake attempt"])(
    "reconciles a retired cancellation wake only with its current owner: %s",
    async (change) => {
      const input = failedRecords("cancelled", { status: "error", error: "stopped" });
      const endedAt = Date.now() - 9 * 24 * 60 * 60_000;
      input.subagent.execution.endedAt = endedAt;
      input.subagent.cleanupCompletedAt = endedAt;
      input.subagent.completion = { required: true };
      input.subagent.delivery = { status: "pending" };
      persistOwner(input);
      database = await reopenCompletionFixtureOwners();
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
          } else if (change === "wake attempt") {
            updated.requesterSettleWake!.status = "dispatching";
            updated.requesterSettleWake!.attemptCount += 1;
          } else {
            updated.requesterSettleWake!.rearmGeneration = 2;
          }
          writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(updated)], []);
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
        database = await reopenCompletionFixtureOwners();
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
          if (change === "wake attempt") {
            expect(restored.requesterSettleWake).toMatchObject({
              status: "dispatching",
              attemptCount: before.requesterSettleWake!.attemptCount + 1,
            });
          }
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
      expect(currentCompletionRun(input).delivery).toEqual(before.delivery);
      expect(currentCompletionRun(input).completion).toEqual(before.completion);
      expect(currentCompletionRun(input).suppressCompletionDelivery).toBe(true);
      expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
      expect(systemEvents()).toEqual([]);
    },
  );
});
