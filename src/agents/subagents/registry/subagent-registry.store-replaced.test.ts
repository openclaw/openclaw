import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { createGatewayRequestContext } from "../../../gateway/server-request-context.js";
import { makeContextParams } from "../../../gateway/server-request-context.test-support.js";
import { resetHeartbeatEventsForTest } from "../../../infra/heartbeat-events.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  blockSubagentCompletionDelivery,
  publishCommittedRecords,
  settleRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import {
  admitCompletionFixtureDatabase,
  failedRecords,
  records,
  requesterWakeDriver,
  seedSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.test-helpers.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import { loadPendingFinalDeliveryPayload } from "./subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  leasePendingAgentSteeringItems,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let settleRootWork: ReturnType<typeof observeRootWork>;
vi.mock("../../../config/config.js", { spy: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-child-store-replaced-"));
  resetSubagentRegistryForTests({ persist: false });
  vi.mocked(getRuntimeConfig).mockReturnValue({});
  settleRootWork = observeRootWork();
  publishSystemEventStoreResolver(() => "original-store");
});

afterEach(async () => {
  await settleRootWork();
  await closeOpenClawStateDatabaseAsync();
  resetSubagentRegistryForTests({ persist: false });
  publishSystemEventStoreResolver(undefined);
  resetHeartbeatEventsForTest();
  vi.mocked(getRuntimeConfig).mockReset();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([false, true])(
  "suspends an original-store child that completes after replacement without a new alert (overlapping new-store wake: %s)",
  async (overlappingWake) => {
    const input = records();
    const now = Date.now();
    let replacementWake: typeof input.subagent.requesterSettleWake;
    if (overlappingWake) {
      input.subagent.execution.endedAt = now + 2_000;
    }
    input.subagent.requesterStorePath = "original-store";
    input.subagent.delivery = {
      status: "pending",
      payload: loadPendingFinalDeliveryPayload(input.subagent),
    };
    input.subagent.requesterSettleWake = overlappingWake
      ? { status: "pending", attemptCount: 0 }
      : {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: [input.subagent.runId],
        };
    const running = structuredClone(input);
    running.subagent.execution = { status: "running", startedAt: input.subagent.createdAt };
    running.subagent.completion = { required: true };
    const database = openOpenClawStateDatabase();
    seedSubagentCompletionDelivery({ subagent: running.subagent });
    publishCommittedRecords(running.subagent);
    publishSystemEventStoreResolver(() => "replacement-store");
    expect(subagentRuns.get(input.subagent.runId)?.execution.status).toBe("running");

    if (overlappingWake) {
      vi.setSystemTime(now + 1_000);
      const replacement = records();
      replacement.subagent.taskRunId = "replacement-task-run";
      replacement.subagent.childSessionKey = "agent:main:subagent:replacement";
      replacement.subagent.createdAt = now + 1_000;
      replacement.subagent.execution.endedAt = now + 1_500;
      // A failed sibling retains its wake without queuing a success-expiry alert.
      replacement.subagent.execution.outcome = { status: "error", error: "replacement failed" };
      replacement.subagent.runId = "replacement-run";

      replacement.subagent.requesterStorePath = "replacement-store";
      replacement.subagent.delivery = { status: "pending" };
      replacement.subagent.requesterSettleWake = { status: "pending", attemptCount: 0 };
      seedSubagentCompletionDelivery({ subagent: replacement.subagent });
      publishCommittedRecords(replacement.subagent);
      expect(
        await blockSubagentCompletionDelivery({
          subagent: expectDefined(subagentRuns.get(replacement.subagent.runId), "new-store child"),
          reason: "completion delivery failed",
        }),
      ).toBe(true);
      replacementWake = structuredClone(
        subagentRuns.get(replacement.subagent.runId)?.requesterSettleWake,
      );
      expect(replacementWake).toMatchObject({ status: "pending" });
      vi.setSystemTime(now + 2_000);
    }

    seedSubagentCompletionDelivery({ subagent: input.subagent });
    publishCommittedRecords(input.subagent);
    const settledEntry = expectDefined(
      subagentRuns.get(input.subagent.runId),
      "late terminal child",
    );
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: input.subagent.requesterSessionKey,
        settledEntry,
        transitionBatch: () => {
          throw new Error("a replaced store must not admit a delivery attempt");
        },
        completeBatch: async (batch, _generation, outcome, onCommitted) => {
          await settleRequesterCompletionBatch({
            entries: batch.map((subagent) => ({
              subagent,
            })),
            outcome: expectDefined(outcome, "store replacement disposition"),
            isCurrent: () => batch.every((entry) => subagentRuns.get(entry.runId) === entry),
          });
          onCommitted?.();
        },
      }),
    ).toBe(false);
    if (overlappingWake) {
      expect(loadSubagentRegistryFromSqlite().get("replacement-run")?.requesterSettleWake).toEqual(
        replacementWake,
      );
    }
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
        .all(),
    ).toEqual([]);
    expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toMatchObject({
      completion: { resultText: "canonical result" },
      delivery: {
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
      },
    });
  },
);

it.each(["ok", "error"] as const)(
  "keeps an observed late-result store retirement after the original selector returns (%s)",
  async (outcome) => {
    const input = records();
    input.subagent.requesterStorePath = "original-store";
    input.subagent.delivery = { status: "pending" };
    input.subagent.execution.outcome = { status: outcome };
    input.subagent.endedReason =
      outcome === "ok" ? SUBAGENT_ENDED_REASON_COMPLETE : SUBAGENT_ENDED_REASON_ERROR;
    const executionBefore = structuredClone(input.subagent.execution);
    const running = structuredClone(input.subagent);
    running.execution = { status: "running", startedAt: running.createdAt };
    running.endedReason = undefined;
    running.completion = { required: true };
    const database = openOpenClawStateDatabase();
    seedSubagentCompletionDelivery({ subagent: running });
    publishCommittedRecords(running);
    publishSystemEventStoreResolver(() => "replacement-store");

    seedSubagentCompletionDelivery({ subagent: input.subagent });
    publishCommittedRecords(input.subagent);
    const entry = expectDefined(subagentRuns.get(input.subagent.runId), "late terminal child");
    const driver = requesterWakeDriver([{ ...input, subagent: entry }]);
    const entered =
      createDeferredCore<Parameters<typeof driver.controller.options.runSubagentAnnounceFlow>[0]>();
    const release = createDeferredCore();
    vi.mocked(driver.controller.options.runSubagentAnnounceFlow).mockImplementation(
      async (params) => {
        entered.resolve(params);
        await release.promise;
        return "retryable";
      },
    );
    try {
      expect(driver.controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
      const announce = await entered.promise;
      expect(announce.isCompletionDeliveryAllowed?.()).toBe(false);
      publishSystemEventStoreResolver(() => "original-store");
      expect(announce.isCompletionDeliveryAllowed?.()).toBe(false);
    } finally {
      release.resolve();
      await settleRootWork(true);
      driver.controller.clearScheduledResumeTimers();
    }

    const saved = loadSubagentRegistryFromSqlite().get(entry.runId);
    expect(saved?.execution).toEqual(executionBefore);
    expect(saved?.completion?.resultText).toBe(input.subagent.completion?.resultText);
    expect(saved?.delivery).toMatchObject({
      status: "suspended",
      disposition: "intentional_non_delivery",
      lastError: "store replaced",
    });
    expect(saved?.requesterSettleWake).toBeUndefined();
    expect(driver.wake).not.toHaveBeenCalled();
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
        .all(),
    ).toEqual([]);
  },
);

it.each([
  "same",
  "replaced",
  "restore",
  "unknown",
  "unknown retry",
  "failed",
  "delivered",
] as const)(
  "keeps automatic child notification disposition through store publication: %s",
  async (change) => {
    const input = change === "failed" ? failedRecords("failed", { status: "error" }) : records();
    const unknownStore = change === "unknown" || change === "unknown retry";
    input.subagent.requesterStorePath = unknownStore ? undefined : "original-store";
    input.subagent.controllerStorePath = unknownStore ? undefined : "original-store";
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.delivery = {
      status: change === "delivered" ? "delivered" : "pending",
      ...(change === "delivered" ? { deliveredAt: Date.now(), announcedAt: Date.now() } : {}),
      payload: loadPendingFinalDeliveryPayload(input.subagent),
    };
    const executionBefore = structuredClone(input.subagent.execution);
    const database = openOpenClawStateDatabase();
    seedSubagentCompletionDelivery({ subagent: input.subagent });
    const receipt = expectDefined(
      loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery,
      "persisted notification receipt",
    );
    subagentRuns.set(input.subagent.runId, input.subagent);
    initSubagentRegistry();
    if (change === "unknown retry") {
      await admitCompletionFixtureDatabase();
      database.db.exec(
        "CREATE TRIGGER reject_store_retirement BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'retirement write rejected'); END",
      );
    }
    if (change === "restore") {
      resetSubagentRegistryForTests({ persist: false });
      publishSystemEventStoreResolver(() => "replacement-store");
      initSubagentRegistry();
      const context = createGatewayRequestContext(makeContextParams());
      context.resolveGatewayContext = () => context;
      activateSubagentRegistry(() => context);
    } else {
      publishSystemEventStoreResolver(() =>
        change === "same" || unknownStore ? "original-store" : "replacement-store",
      );
    }
    publishSystemEventStoreResolver(() => "original-store");
    if (change === "unknown retry") {
      const context = createGatewayRequestContext(makeContextParams());
      context.resolveGatewayContext = () => context;
      activateSubagentRegistry(() => context);
      try {
        await expect(settleRootWork(true)).rejects.toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({ message: "retirement write rejected" }),
          ]),
        });
        expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery).toEqual(
          receipt,
        );
        expect(() => subagentRuns.runWithCompletionAuthority(input.subagent, () => "send")).toThrow(
          /store was retired/,
        );
      } finally {
        database.db.exec("DROP TRIGGER reject_store_retirement");
      }
      // The active registry owns retry even when the selector never publishes again.
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await settleRootWork(true);
    const persisted = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
    if (unknownStore) {
      expect(persisted?.requesterStorePath).toBeUndefined();
      expect(persisted?.controllerStorePath).toBeUndefined();
    }
    expect(persisted?.completion?.resultText).toBe(input.subagent.completion?.resultText);
    expect(persisted?.execution).toEqual(executionBefore);
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
        .all(),
    ).toEqual([]);
    if (change === "delivered") {
      expect(persisted?.delivery).toEqual(receipt);
    } else if (change !== "same") {
      expect(persisted?.delivery).toMatchObject({
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
        payload: receipt.payload,
      });
      expect(persisted?.requesterSettleWake).toBeUndefined();
    }
    const lease = await leasePendingAgentSteeringItems({
      requesterSessionKey: input.subagent.requesterSessionKey,
      leaseId: "after-store-publication",
    });
    if (change === "same") {
      expect(lease?.prompt).toContain("canonical result");
    } else {
      expect(lease).toBeUndefined();
    }
  },
);

it("keeps retirement authority closed when the original selector returns before the worker acknowledgment", async () => {
  const input = records();
  input.subagent.requesterStorePath = "original-store";
  input.subagent.delivery = {
    status: "pending",
    payload: loadPendingFinalDeliveryPayload(input.subagent),
  };
  seedSubagentCompletionDelivery({ subagent: input.subagent });
  subagentRuns.set(input.subagent.runId, input.subagent);
  initSubagentRegistry();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const runWorker = stateWorker.runOpenClawStateWorkerOperation;
  let observed = false;
  let settling: Promise<void> | undefined;
  const held = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      runWorker(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "sessionDelivery.mutateSubagentCompletion") {
                observed = true;
                entered.resolve();
                await release.promise;
              }
              return result;
            },
          }),
        options,
      ),
    );
  try {
    publishSystemEventStoreResolver(() => "replacement-store");
    publishSystemEventStoreResolver(() => "original-store");
    expect(subagentRuns.isCompletionAuthorityRetired(input.subagent)).toBe(true);
    settling = settleRootWork(true);
    await Promise.race([entered.promise, settling]);
    expect(observed).toBe(true);
    expect(() => subagentRuns.runWithCompletionAuthority(input.subagent, () => "send")).toThrow(
      /store was retired/,
    );
    expect(() =>
      subagentRuns.runWithCompletionBatchAuthority([input.subagent], () => "send"),
    ).toThrow(/store was retired/);
    const successor = { ...structuredClone(input.subagent), runId: "replacement-completion" };
    const rollback = subagentRuns.transferCompletionAuthority(input.subagent, successor);
    expect(() => subagentRuns.runWithCompletionAuthority(successor, () => "send")).toThrow(
      /store was retired/,
    );
    rollback();
    expect(subagentRuns.isCompletionAuthorityRetired(input.subagent)).toBe(true);
    expect(subagentRuns.isCompletionAuthorityRetired(successor)).toBe(true);
  } finally {
    release.resolve();
    await settling;
    await settleRootWork(true);
    held.mockRestore();
  }
  expect(input.subagent.delivery).toMatchObject({
    status: "suspended",
    disposition: "intentional_non_delivery",
  });
  expect(subagentRuns.isCompletionAuthorityRetired(input.subagent)).toBe(true);
});
