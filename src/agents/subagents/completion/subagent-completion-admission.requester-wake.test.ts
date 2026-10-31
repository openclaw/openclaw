import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { loadPendingFinalDeliveryPayload } from "../registry/subagent-delivery-state.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "../registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite as loadRegistry } from "../registry/subagent-registry-state.fixture.test-support.js";
import { bindSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../registry/subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import { registerRequesterWakeOwnershipTests } from "./subagent-completion-admission.requester-wake-ownership.test-support.js";
import {
  blockSubagentCompletionDelivery,
  mutateRequesterCompletionBatch,
} from "./subagent-completion-admission.store.js";
import {
  currentCompletionRun as currentRun,
  readCompletionSystemEvents as systemEvents,
  advanceRequesterWakeTime as advanceWake,
  armRequesterWake,
  reopenCompletionFixtureOwners as reopenOwners,
  failedRecords,
  records,
  requesterWakeDriver,
  observeRequesterOutcomePublication,
  seedSubagentCompletionOwner,
  settleRequesterCompletionBatch,
  updateCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";
import { mutateSubagentCompletionInDatabase } from "./subagent-completion-mutation.kernel.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("persisted subagent requester wakes", () => {
  const db = useCompletionDatabase("openclaw-subagent-wake-");

  const persistOwner = (input: ReturnType<typeof records>) =>
    seedSubagentCompletionOwner({
      subagent: input.subagent,
      databaseOptions: { database: db.value },
    });

  const stored = (input: ReturnType<typeof records>) => loadRegistry().get(input.subagent.runId);
  const settleOne = (
    input: ReturnType<typeof records>,
    outcome: NonNullable<Parameters<typeof settleRequesterCompletionBatch>[0]["outcome"]>,
  ) =>
    settleRequesterCompletionBatch({
      entries: [input.subagent],
      outcome,
      databaseOptions: { database: db.value },
    });
  const expectNoRejection = (driver: ReturnType<typeof requesterWakeDriver>) =>
    expect(driver.warn).not.toHaveBeenCalledWith(
      "failed to persist requester settle wake rejection",
      expect.any(Object),
    );
  function wakeBatch(...names: string[]) {
    const inputs = names.map((name) => {
      const input = records();
      input.subagent.runId = `completion-${name}`;
      if (name !== "run") {
        input.subagent.childSessionKey = `agent:main:subagent:${name}`;
      }
      return input;
    });
    const ids = inputs.map(({ subagent }) => subagent.runId);
    return inputs.map((input) => armRequesterWake(input, ids));
  }

  registerRequesterWakeOwnershipTests({ database: () => db.value, persistOwner });
  it("reconciles an acknowledged retirement without even a no-op data write", async () => {
    const input = armRequesterWake(records());
    input.subagent.expectsCompletionMessage = false;
    input.subagent.delivery = { status: "not_required" };
    input.subagent.requesterSettleWake!.retireAfterSettle = true;
    persistOwner(input);
    let committed: RequesterWakeCommittedWrite | undefined;
    await expect(
      mutateRequesterCompletionBatch({
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
    expect(loadRegistry().has(input.subagent.runId)).toBe(false);
    runOpenClawStateWriteTransaction(
      () => {
        const sql = observeHostDataSql();
        try {
          const result = mutateSubagentCompletionInDatabase(db.value, {
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
      { database: db.value, path: db.value.path },
    );
    expect(loadRegistry().has(input.subagent.runId)).toBe(false);
  });

  it.each([true, false])(
    "keeps active cleanup unless requester delivery is blocked (delivered=%s)",
    async (delivered) => {
      const input = armRequesterWake(records());
      input.subagent.cleanupCompletedAt = undefined;
      persistOwner(input);
      const driver = requesterWakeDriver([input]);
      const generation = driver.controller.bumpCleanupGeneration(input.subagent);

      await settleOne(input, {
        delivered,
        path: "direct",
        error: delivered ? undefined : "requester unavailable",
      });

      expect(driver.controller.isCleanupAttemptCurrent(input.subagent, generation)).toBe(delivered);
      expect(currentRun(input).requesterSettleWake).toBeUndefined();
      expect(stored(input)?.cleanupHandled).toBe(false);
    },
  );

  it.each([true, false])(
    "settles the current wake after child lifecycle turnover across reopen (delivered=%s)",
    async (delivered) => {
      for (const wave of [1, 2]) {
        const input = armRequesterWake(records());
        input.subagent.runId += `-${wave}`;
        input.subagent.execution.lifecycleGeneration = "original-lifecycle";
        input.subagent.requesterSettleWake = { status: "dispatching", attemptCount: 1 };
        input.subagent.completionRequesterSessionId = "requester-session";
        input.subagent.requesterStorePath = path.join(
          process.env.OPENCLAW_STATE_DIR!,
          "sessions.json",
        );
        const scope = {
          sessionKey: input.subagent.requesterSessionKey,
          agentId: input.subagent.requesterAgentId,
          storePath: input.subagent.requesterStorePath,
          sessionId: "requester-session",
        };
        await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
        persistOwner(input);
        // Old dispatching rows must converge on their next evaluation without a migration.
        db.value = await reopenOwners();
        input.subagent = subagentRuns.get(input.subagent.runId)!;
        using driver = requesterWakeDriver([input]);
        driver.wake.mockImplementation(async (params) => {
          await updateCompletionOwner(input.subagent.runId, (current) => ({
            ...current,
            execution: { ...current.execution, lifecycleGeneration: "cleaned-lifecycle" },
          }));
          if (delivered) {
            await params.completeBatch([params.settledEntry], undefined, {
              delivered: true,
              path: "direct",
              requesterVisibleFinalDelivered: true,
            });
          } else {
            await params.transitionBatch(
              [params.settledEntry],
              {
                ...params.settledEntry.requesterSettleWake!,
                status: "dispatching",
                attemptCount: 1,
                nextAttemptAt: Date.now() + 30_000,
              },
              () => {},
            );
          }
          return delivered;
        });
        await driver.run();
        expectNoRejection(driver);
        expect(currentRun(input).requesterSettleWake).toBeUndefined();
        expect(currentRun(input).delivery?.status).toBe(delivered ? "delivered" : "failed");
        db.value = await reopenOwners();
        await driver.sweep();
        expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
        expect(subagentRuns.get(input.subagent.runId)?.execution.lifecycleGeneration).toBe(
          "cleaned-lifecycle",
        );
        expect(driver.wake).toHaveBeenCalledOnce();
        const notices = (await loadTranscriptEvents(scope)).filter((event) =>
          JSON.stringify(event).includes("Subagent result could not be delivered"),
        );
        expect(notices).toHaveLength(delivered ? 0 : wave);
      }
    },
  );

  it("settles lost operator authority without discarding child results or queuing a notice", async () => {
    const input = armRequesterWake(records());
    input.subagent.cleanupCompletedAt = undefined;
    persistOwner(input);
    const before = structuredClone(input.subagent);

    await settleOne(input, {
      delivered: false,
      path: "none",
      disposition: "permanent_failure",
      reason: "operator_authority_unavailable",
      error: "The original operator no longer has access",
    });

    db.value = await reopenOwners();
    const restored = subagentRuns.get(input.subagent.runId)!;
    expect(restored.execution).toEqual(before.execution);
    expect(restored.completion).toEqual(before.completion);
    expect(restored).toMatchObject({
      delivery: {
        status: "failed",
        disposition: "permanent_failure",
        lastError: "The original operator no longer has access",
      },
      suppressCompletionDelivery: true,
    });
    expect(restored.requesterSettleWake).toBeUndefined();
    expect(restored.delivery?.queueId).toBeUndefined();
    expect(systemEvents(db.value)).toEqual([]);
  });

  it("settles a rejected dispatch transition after rollback without another wake", async () => {
    const input = armRequesterWake(records());
    persistOwner(input);
    using driver = requesterWakeDriver([input]);
    db.value.db.exec(
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
    await driver.run();
    expect(currentRun(input).requesterSettleWake).toBeUndefined();
    expect(currentRun(input).delivery).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("dispatch write failed"),
    });
    db.value.db.exec("DROP TRIGGER reject_dispatch");
    db.value = await reopenOwners();
    expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
    expect(driver.wake).toHaveBeenCalledOnce();
  });

  it.each(["dispatch", "complete"])(
    "preserves newer same-generation progress before %s admission",
    async (operation) => {
      vi.useFakeTimers({ toNotFake: ["hrtime", "performance"] });
      const input = armRequesterWake(records());
      persistOwner(input);
      const driver = requesterWakeDriver([input]);
      const advancedWake = {
        ...input.subagent.requesterSettleWake!,
        status: "dispatching" as const,
        attemptCount: 2,
        nextAttemptAt: Date.now() + 30_000,
      };
      const published = vi.fn();
      driver.wake.mockImplementation(async (params) => {
        await updateCompletionOwner(input.subagent.runId, (current) => ({
          ...current,
          requesterSettleWake: advancedWake,
        }));
        if (operation === "complete") {
          await params.completeBatch([params.settledEntry], 1);
        } else {
          await params.transitionBatch(
            [params.settledEntry],
            { ...input.subagent.requesterSettleWake!, status: "dispatching", attemptCount: 1 },
            published,
          );
        }
        return false;
      });
      try {
        await driver.run();
        expect(published).not.toHaveBeenCalled();
        expect(currentRun(input).requesterSettleWake).toEqual(advancedWake);
        expect(stored(input)?.requesterSettleWake).toEqual(advancedWake);
        expect(driver.wake).toHaveBeenCalledOnce();
      } finally {
        driver.controller.clearRuntimeState();
        vi.useRealTimers();
      }
    },
  );

  it.each(["omitted sibling", "second run write", "retirement"] as const)(
    "commits the entire requester batch or nothing when %s refuses settlement",
    async (cut) => {
      const inputs = wakeBatch("run", "second");
      for (const input of inputs) {
        if (cut === "retirement") {
          input.subagent.requesterSettleWake!.retireAfterSettle = true;
        }
        persistOwner(input);
      }
      const liveBefore = inputs.map(({ subagent }) => structuredClone(subagent));
      if (cut !== "omitted sibling") {
        db.value.db.exec(
          cut === "second run write"
            ? "CREATE TRIGGER reject_batch AFTER UPDATE ON subagent_runs WHEN NEW.run_id = 'completion-second' BEGIN SELECT RAISE(ABORT, 'cut:second'); END"
            : "CREATE TRIGGER reject_batch AFTER DELETE ON subagent_runs WHEN OLD.run_id = 'completion-second' BEGIN SELECT RAISE(ABORT, 'cut:retirement'); END",
        );
      }
      const snapshot = () =>
        ["subagent_runs", "delivery_queue_entries"].map((table) =>
          db.value.db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all(),
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
        expect(observed).not.toHaveBeenCalled();
        if (cut === "second run write" || cut === "retirement") {
          db.value.db.exec("DROP TRIGGER reject_batch");
        }
        db.value = await reopenOwners();
        expect(snapshot()).toEqual(before);
        for (const input of inputs) {
          input.subagent = subagentRuns.get(input.subagent.runId)!;
        }
        using retry = requesterWakeDriver(inputs);
        await retry.run();
        expect(observed).toHaveBeenCalledOnce();
        expect(observed.mock.results[0]?.value).toEqual([undefined, undefined]);
        expect(systemEvents(db.value)).toEqual([]);
        db.value = await reopenOwners();
        for (const input of inputs) {
          expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
          expect(subagentRuns.has(input.subagent.runId)).toBe(cut !== "retirement");
        }
      } finally {
        unsubscribe();
        driver.controller.clearRuntimeState();
      }
    },
  );

  it("replaces an in-progress completion receipt on requester settlement and clears pending payloads", async () => {
    const input = armRequesterWake(records());
    const receipt = input.subagent.delivery!;
    receipt.payload = loadPendingFinalDeliveryPayload(input.subagent);
    receipt.attemptCount = 2;
    const before = structuredClone(receipt);
    persistOwner(input);
    using driver = requesterWakeDriver([input]);
    driver.wake.mockImplementation(async (params) => {
      await params.completeBatch([input.subagent], 1, { delivered: true, path: "direct" });
      return true;
    });
    await driver.run();
    expect(currentRun(input).delivery).not.toBe(receipt);
    expect(currentRun(input).delivery?.status).toBe("delivered");
    expect(currentRun(input).delivery?.payload).toBeUndefined();
    expect(currentRun(input).delivery?.attemptCount).toBeUndefined();
    expect(receipt).toEqual(before);
    expect(currentRun(input).requesterSettleWake).toBeUndefined();
    db.value = await reopenOwners();
    expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("delivered");
    expect(subagentRuns.get(input.subagent.runId)?.delivery?.payload).toBeUndefined();
  });

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
      const inputs = wakeBatch("run", "second", "third");
      const [first, second, third] = [inputs[0]!, inputs[1]!, inputs[2]!];
      for (const input of inputs) {
        if (input === second && change === "blocked retirement") {
          input.subagent.requesterSettleWake!.retireAfterSettle = true;
        }
        input.subagent.requesterSettleWake!.status = "dispatching";
        input.subagent.requesterSettleWake!.attemptCount = 1;
        persistOwner(input);
      }
      const driver = requesterWakeDriver(inputs);
      const finalized = vi.fn();
      const transport = vi.fn();
      const newerWakes: SubagentRunRecord[] = [];
      const publication = await observeRequesterOutcomePublication(cut, originalStateDir);
      driver.wake.mockImplementation(async (params) => {
        if (params.settledEntry.requesterSettleWake?.rearmGeneration === 2) {
          newerWakes.push(params.settledEntry);
          return false;
        }
        transport();
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
      await updateCompletionOwner(first.subagent.runId, (current) => ({
        ...current,
        execution: { ...current.execution, lifecycleGeneration: "cleaned-lifecycle" },
      }));
      if (cut === "rejected") {
        db.value.db.exec(
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
          expect(stored(first)?.delivery?.status).toBe("delivered");
          expect(currentRun(first).requesterSettleWake).toBeDefined();
          await restoreSubagentRunsFromDisk({ runs: subagentRuns });
        } else {
          db.value.db.exec("DROP TRIGGER reject_outcome");
        }
        const blocked = change.startsWith("blocked");
        if (blocked) {
          expect(
            await blockSubagentCompletionDelivery({
              subagent: second.subagent,

              reason: "B was independently closed",
              databaseOptions: { database: db.value },
            }),
          ).toBe(true);
          expect(currentRun(second).requesterSettleWake?.rearmGeneration).toBe(1);
        }
        const successor = structuredClone(currentRun(second));
        if (change === "retired") {
          await updateCompletionOwner(second.subagent.runId, () => null);
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
          await updateCompletionOwner(successor.runId, (current) => ({
            ...current,
            generation: successor.generation,
            requesterSettleWake: successor.requesterSettleWake,
          }));
        }
        const newerWake = structuredClone(successor.requesterSettleWake);
        if (cut === "committed") {
          db.value.db.exec(
            "CREATE TRIGGER reject_outcome AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'committed outcome must not replay'); END",
          );
        }
        await advanceWake(30_000, () =>
          driver.controller.resumeRequesterSettleWake(first.subagent.runId, first.subagent),
        );
        expect(transport).toHaveBeenCalledOnce();
        expect(newerWakes).toEqual(
          ["rearmed", "replaced", "blocked newer wave"].includes(change)
            ? [
                expect.objectContaining({
                  runId: second.subagent.runId,
                  requesterSettleWake: expect.objectContaining({ rearmGeneration: 2 }),
                }),
              ]
            : [],
        );
        for (const input of [first, third]) {
          expect(currentRun(input).requesterSettleWake).toBeUndefined();
          expect(currentRun(input).delivery?.status).toBe(delivered ? "delivered" : "failed");
        }
        expect(finalized).toHaveBeenCalledOnce();
        if (change !== "retired" && change !== "blocked retirement") {
          expect(currentRun({ subagent: successor }).requesterSettleWake).toEqual(
            change === "blocked" ? undefined : newerWake,
          );
          expect(currentRun({ subagent: successor }).delivery?.status).toBe(
            blocked ? "failed" : cut === "committed" ? "delivered" : "in_progress",
          );
        } else {
          expect(subagentRuns.has(second.subagent.runId)).toBe(false);
        }
        if (cut === "committed") {
          await advanceWake(0, () =>
            driver.controller.resumeRequesterSettleWake(first.subagent.runId, first.subagent),
          );
          expect(transport).toHaveBeenCalledOnce();
          expect(finalized).toHaveBeenCalledOnce();
          expect(publication.reconciledBatches).toEqual([
            [first.subagent.runId, third.subagent.runId],
          ]);
          expectNoRejection(driver);
          db.value.db.exec("DROP TRIGGER reject_outcome");
        }
        db.value = await reopenOwners();
        for (const input of [first, third]) {
          expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
        }
        expect(subagentRuns.get(second.subagent.runId)?.requesterSettleWake).toEqual(
          ["retired", "blocked", "blocked retirement"].includes(change) ? undefined : newerWake,
        );
        expect(systemEvents(db.value)).toEqual([]);
      } finally {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
        publication.restore();
        db.value.db.exec("DROP TRIGGER IF EXISTS reject_outcome");
        driver.controller.clearRuntimeState();
        vi.useRealTimers();
      }
    },
  );

  it.each(["failed", "timed_out", "yielded"] as const)(
    "settles an uncaptured %s wake without changing the child result",
    async (status) => {
      const input =
        status === "yielded"
          ? armRequesterWake(records())
          : failedRecords(status, { status: status === "timed_out" ? "timeout" : "error" });
      input.subagent.completion = { required: true };
      if (status === "yielded") {
        Object.assign(input.subagent, {
          pauseReason: "sessions_yield",
          delivery: { status: "pending" },
          cleanupHandled: false,
          cleanupCompletedAt: undefined,
        });
        input.subagent.execution.outcome = undefined;
        input.subagent.requesterSettleWake!.retireAfterSettle = true;
      }
      persistOwner(input);
      const before = structuredClone(input.subagent);
      using driver = requesterWakeDriver([input]);
      if (status === "yielded") {
        driver.wake.mockImplementation(async (params) => {
          await params.completeBatch([params.settledEntry], 1, { delivered: true, path: "direct" });
          return true;
        });
      }
      await driver.run();
      expectNoRejection(driver);
      db.value = await reopenOwners();
      const restored = subagentRuns.get(input.subagent.runId)!;
      expect(restored.requesterSettleWake).toBeUndefined();
      if (status === "yielded") {
        expect(restored).toEqual({ ...before, requesterSettleWake: undefined });
      } else {
        expect([restored.execution, restored.completion]).toEqual([
          before.execution,
          before.completion,
        ]);
      }
      expect(systemEvents(db.value)).toEqual([]);
      expect(driver.wake).toHaveBeenCalledOnce();
    },
  );

  it.each(["missing outcome", "paused"] as const)(
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
      await expect(
        blockSubagentCompletionDelivery({
          subagent: input.subagent,
          reason: "requester unavailable",
        }),
      ).resolves.toBe(false);
      db.value = await reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)).toEqual(before.subagent);
      expect(systemEvents(db.value)).toEqual([]);
    },
  );

  it.each(["delivered", "store replaced", "operator authority lost"] as const)(
    "settles a pause notice across reopen (%s)",
    async (settlement) => {
      const storeReplaced = settlement === "store replaced";
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

      await settleOne(paused, {
        delivered: settlement === "delivered",
        path: "direct",
        ...(storeReplaced
          ? { storeReplaced: true, disposition: "intentional_non_delivery" as const }
          : {}),
        ...(settlement === "operator authority lost"
          ? {
              disposition: "permanent_failure" as const,
              reason: "operator_authority_unavailable" as const,
            }
          : {}),
      });
      db.value = await reopenOwners();
      const restored = subagentRuns.get(paused.subagent.runId)!;
      expect(restored.requesterSettleWake).toEqual(
        settlement === "delivered" ? completionWake : undefined,
      );
      expect(restored.pauseReason).toBe("sessions_yield");
      expect(restored.execution.outcome).toBeUndefined();
      expect(restored.delivery).toEqual({ status: "pending" });
      expect(subagentRuns.get(sibling.subagent.runId)).toEqual(siblingBefore);
      expect(systemEvents(db.value)).toEqual([]);
    },
  );

  it.each(["unchanged", "newer sibling", "run generation"])(
    "reconciles a retired cancellation wake only with its current owner: %s",
    async (change) => {
      const input = failedRecords("cancelled", { status: "error", error: "stopped" });
      const endedAt = Date.now() - 9 * 24 * 60 * 60_000;
      input.subagent.execution.endedAt = endedAt;
      input.subagent.cleanupCompletedAt = endedAt;
      input.subagent.completion = { required: true };
      input.subagent.delivery = { status: "pending" };
      persistOwner(input);
      db.value = await reopenOwners();
      input.subagent = subagentRuns.get(input.subagent.runId)!;
      const before = structuredClone(input.subagent);
      using driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async () => {
        if (change !== "unchanged") {
          const updated = structuredClone(input.subagent);
          if (change === "newer sibling") {
            updated.runId = "newer-child-run";
          }
          updated.generation = (updated.generation ?? 0) + 1;
          writeSubagentRunValuesInDatabase(db.value, [bindSubagentRunRecord(updated)], []);
        }
        throw new Error("requester unavailable");
      });
      await driver.run();
      if (change === "unchanged") {
        expectNoRejection(driver);
      } else {
        expect(driver.warn).toHaveBeenCalledWith(
          "failed to persist requester settle wake rejection",
          expect.any(Object),
        );
      }
      db.value = await reopenOwners();
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
      expect(db.value.db.prepare("SELECT COUNT(*) AS count FROM task_runs").get()?.count).toBe(0);
      expect(systemEvents(db.value)).toEqual([]);
    },
  );

  it("retains a frozen wake and source-owned not_required disposition across rejected commits", async () => {
    const input = armRequesterWake(records());
    input.subagent.suppressCompletionDelivery = true;
    input.subagent.delivery = {
      status: "not_required",
      disposition: "intentional_non_delivery",
      generation: 1,
    };
    input.subagent.requesterSettleWake!.requesterYieldBatch = true;
    persistOwner(input);
    const before = structuredClone(input.subagent);
    const settleFrozen = () => settleOne(input, { delivered: true, path: "direct" });
    db.value.db.exec(
      "CREATE TRIGGER reject_closed_wake AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'temporary closed-wake write failure'); END",
    );
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await expect(settleFrozen()).rejects.toThrow("temporary closed-wake write failure");
        expect(input.subagent).toEqual(before);
        expect(stored(input)).toMatchObject({
          delivery: before.delivery,
          requesterSettleWake: before.requesterSettleWake,
          suppressCompletionDelivery: true,
        });
      }
    } finally {
      db.value.db.exec("DROP TRIGGER reject_closed_wake");
    }
    await settleFrozen();
    expect(currentRun(input).delivery).toEqual(before.delivery);
    expect(currentRun(input).completion?.resultText).toBeUndefined();
    expect(stored(input)?.completion).toEqual(before.completion);
    expect(currentRun(input).suppressCompletionDelivery).toBe(true);
    expect(currentRun(input).requesterSettleWake).toBeUndefined();
    expect(systemEvents(db.value)).toEqual([]);
  });
});
