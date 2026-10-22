import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import * as hookRunnerGlobal from "../../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { isDeliverySuspended } from "../registry/subagent-delivery-state.js";
import { createSubagentRegistryContextCleanup } from "../registry/subagent-registry-context-cleanup.js";
import * as registryDeps from "../registry/subagent-registry-deps.js";
import { subagentRegistryLog } from "../registry/subagent-registry-lifecycle-log.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  bindSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "../registry/subagent-run-generation.js";
import { useCompletionDatabase } from "./completion-database.test-support.js";
import {
  blockSubagentCompletionDelivery,
  mutateRequesterCompletionBatch,
} from "./subagent-completion-admission.store.js";
import {
  currentCompletionRun,
  armRequesterWake,
  reopenCompletionFixtureOwners,
  records,
  requesterWakeDriver,
  readCompletionSystemEvents,
  seedSubagentCompletionOwner,
  settleRequesterCompletionBatch,
  withSubagentCompletionWorkerState,
} from "./subagent-completion-admission.test-helpers.js";

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("completion receipt expiry", () => {
  const db = useCompletionDatabase("openclaw-expired-receipt-");

  async function suspend(
    reason: "expiry" | "permanent_failure" = "expiry",
    completionTarget?: "parent",
    resultText: string | null = "canonical result",
  ) {
    const input = armRequesterWake(records());
    input.subagent.cleanupHandled = false;
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.delivery = { status: "pending", generation: 1 };
    input.subagent.completionTarget = completionTarget;
    input.subagent.completionRequesterSessionId = completionTarget
      ? "requester-session"
      : undefined;
    input.subagent.completion!.resultText = resultText;
    seedSubagentCompletionOwner({ ...input, databaseOptions: { database: db.value } });
    expect(
      await blockSubagentCompletionDelivery({
        subagent: input.subagent,
        reason: "completion delivery expired",
        suspendedReason: reason,
        databaseOptions: { database: db.value },
      }),
    ).toBe(true);
    input.subagent = currentCompletionRun(input);
    expect(isDeliverySuspended(input.subagent)).toBe(true);
    return input;
  }

  function settle(input: ReturnType<typeof records>, delivered: boolean) {
    return settleRequesterCompletionBatch({
      entries: [input.subagent],
      outcome: { delivered, path: "direct", error: delivered ? undefined : "requester failed" },
      assertCurrent: () => {},
      databaseOptions: { database: db.value },
    });
  }

  it.each([
    [undefined, "canonical result", true],
    ["parent", null, true],
    [undefined, "canonical result", false],
  ] as const)(
    "settles expiry (target=%s, result=%s, delivered=%s)",
    async (completionTarget, resultText, delivered) => {
      const input = await suspend("expiry", completionTarget, resultText);
      const before = structuredClone(input.subagent);
      const notices = readCompletionSystemEvents(db.value);
      if (!delivered) {
        expect(notices).toHaveLength(1);
      }
      using driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        await params.completeBatch(
          [input.subagent],
          1,
          delivered
            ? { delivered: true, path: "direct" }
            : { delivered: false, path: "none", error: "requester turn failed" },
        );
        return delivered;
      });
      await driver.run();
      if (delivered) {
        expect(driver.warn).not.toHaveBeenCalled();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(isDeliverySuspended(currentCompletionRun(input))).toBe(false);
      }
      db.value = await reopenCompletionFixtureOwners();
      const stored = subagentRuns.get(input.subagent.runId);
      expect(stored?.requesterSettleWake).toBeUndefined();
      if (delivered) {
        expect(stored?.delivery?.status).toBe("delivered");
        for (const key of ["suspendedAt", "suspendedReason", "lastError", "payload"] as const) {
          expect(stored?.delivery?.[key]).toBeUndefined();
        }
        expect(stored?.completion?.resultText).toBe(resultText);
      } else {
        expect(stored).toMatchObject({
          delivery: {
            status: "failed",
            disposition: "permanent_failure",
            lastError: "requester turn failed",
          },
          suppressCompletionDelivery: true,
        });
        expect(stored?.completion).toEqual(before.completion);
        expect(stored?.delivery?.payload).toEqual(before.delivery?.payload);
        expect(readCompletionSystemEvents(db.value)).toEqual(notices);
      }
    },
  );

  it("does not recover permanent_failure from a successful receipt", async () => {
    const input = await suspend("permanent_failure");
    await settle(input, true);
    db.value = await reopenCompletionFixtureOwners();
    expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
  });

  it.each([
    "run",
    "execution",
    "host incarnation",
    "delivery generation",
    "registry write",
    "failed settlement write",
  ] as const)(
    "preserves the suspended delivery and wake when %s rejects the receipt",
    async (cut) => {
      const input = await suspend();
      const changed = structuredClone(input.subagent);
      if (cut === "run") {
        changed.taskRunId = "replacement-source-run";
      } else if (cut === "host incarnation") {
        bindSubagentRunRuntimeKey(changed, {});
        subagentRuns.set(changed.runId, changed);
      } else if (cut === "execution") {
        changed.endedReason = "subagent-killed";
        changed.execution.outcome = { status: "error", error: "cancelled by the requester" };
      } else if (cut === "delivery generation") {
        changed.delivery!.generation = 2;
      }
      const rejectWrite = cut === "registry write" || cut === "failed settlement write";
      if (cut !== "host incarnation" && !rejectWrite) {
        await mutateSubagentRuns(
          [changed.runId],
          () => ({ value: undefined, postimages: new Map([[changed.runId, changed]]) }),
          { runs: subagentRuns },
        );
      }
      if (rejectWrite) {
        db.value.db.exec(
          "CREATE TRIGGER reject_ack AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'ack write cut'); END",
        );
      }
      try {
        await expect(settle(input, cut !== "failed settlement write")).rejects.toThrow(
          rejectWrite ? "ack write cut" : /(owner|cohort) changed before mutation/,
        );
        expect(isDeliverySuspended(input.subagent)).toBe(true);
        expect(currentCompletionRun(input).requesterSettleWake).toBeDefined();
      } finally {
        if (rejectWrite) {
          db.value.db.exec("DROP TRIGGER reject_ack");
        }
      }
      db.value = await reopenCompletionFixtureOwners();
      const stored = currentCompletionRun(input);
      expect(isDeliverySuspended(stored)).toBe(true);
      expect(stored.requesterSettleWake).toBeDefined();
      if (cut === "delivery generation") {
        expect(stored.delivery).toMatchObject({ status: "suspended", generation: 2 });
      }
    },
  );
});

it.each(["transition", "complete"] as const)(
  "publishes a requester wake %s before recording its concurrent ended hook",
  async (operation) => {
    await withSubagentCompletionWorkerState(async () => {
      setRuntimeConfigSnapshot({});
      const input = armRequesterWake(records());
      seedSubagentCompletionOwner(input);
      const registry = createEmptyPluginRegistry();
      registry.typedHooks.push({
        pluginId: "test",
        hookName: "subagent_ended",
        source: "test",
        handler: async () => {},
      });
      const hookRunner = createHookRunner(registry);
      const hookReached = createDeferred();
      const runtime = vi
        .spyOn(registryDeps, "loadSubagentRegistryPluginRuntimeHandle")
        .mockResolvedValue(registry);
      const hooks = vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockImplementation(() => {
        hookReached.resolve();
        return hookRunner;
      });
      using warn = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
      const cleanup = createSubagentRegistryContextCleanup({
        isEndedHookOwnerCurrent: (entry) =>
          isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry),
      });
      const acknowledged = createDeferred();
      const releaseAcknowledgement = createDeferred();
      const worker = probe.command(stateWorker, async (command, executeOptions, scope) => {
        const receipt = await scope.execute(command, executeOptions);
        if (command.type === "sessionDelivery.mutateSubagentCompletion") {
          acknowledged.resolve();
          await releaseAcknowledgement.promise;
        }
        return receipt;
      });
      const publication = mutateRequesterCompletionBatch({
        entries: [input.subagent],
        operation:
          operation === "complete"
            ? { kind: "complete" }
            : {
                kind: "transition",
                state: { status: "dispatching", attemptCount: 1, rearmGeneration: 1 },
              },
        context: captureOpenClawStateWorkerContext(),
        assertCurrent: () => {
          if (subagentRuns.get(input.subagent.runId) !== input.subagent) {
            throw new Error("Requester wake lost its registered owner");
          }
        },
        onCommitted: () => {},
        onPublished: () => {},
      });
      let hook: Promise<void> | undefined;
      try {
        await Promise.race([
          acknowledged.promise,
          publication.then(() => {
            throw new Error("Requester wake returned before its held acknowledgement");
          }),
        ]);
        hook = cleanup.emitSubagentEndedHookForRun({ entry: input.subagent });
        await Promise.race([
          hookReached.promise,
          hook.then(() => {
            throw new Error("Ended hook returned before reaching its producer");
          }),
        ]);
        expect.soft(input.subagent.endedHookEmittedAt).toBeUndefined();
        releaseAcknowledgement.resolve();
        await expect(publication).resolves.toEqual({ applied: true, publication: "published" });
        await hook;
        expect(currentCompletionRun(input).endedHookEmittedAt).toEqual(expect.any(Number));
        const stored = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
        expect(stored?.endedHookEmittedAt).toBe(currentCompletionRun(input).endedHookEmittedAt);
        if (operation === "complete") {
          expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
          expect(stored?.requesterSettleWake).toBeUndefined();
        } else {
          expect(currentCompletionRun(input).requesterSettleWake).toMatchObject({
            status: "dispatching",
            attemptCount: 1,
            rearmGeneration: 1,
          });
          expect(stored?.requesterSettleWake).toEqual(
            currentCompletionRun(input).requesterSettleWake,
          );
        }
        expect(warn).not.toHaveBeenCalled();
      } finally {
        releaseAcknowledgement.resolve();
        await Promise.allSettled([publication, ...(hook ? [hook] : [])]);
        worker.mockRestore();
        hooks.mockRestore();
        runtime.mockRestore();
      }
    });
  },
);
