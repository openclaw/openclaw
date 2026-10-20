import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { sha256Hex } from "../../../infra/crypto-digest.js";
import { loadPendingSessionDeliveries } from "../../../infra/session-delivery-queue-storage.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../registry/subagent-registry-read.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { createSubagentRegistrySweeper } from "../registry/subagent-registry-sweeper.js";
import { observeRootWork } from "../registry/subagent-registry.browser-cleanup.test-support.js";
import { bindSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../registry/subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { mutateRequesterCompletionBatch } from "./subagent-completion-admission.store.js";

/** Admit the actual worker before tests add deliberate runtime write-failure triggers. */
export async function admitCompletionFixtureDatabase(): Promise<void> {
  await loadPendingSessionDeliveries(captureOpenClawStateWorkerContext());
}

export function readCompletionSystemEvents(database: OpenClawStateDatabase) {
  return database.db
    .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
    .all();
}

export function seedSubagentCompletionDelivery(params: {
  subagent: SubagentRunRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): void {
  runOpenClawStateWriteTransaction((database) => {
    writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(params.subagent)], []);
  }, params.databaseOptions);
}

export function seedSubagentCompletionOwner(
  params: Parameters<typeof seedSubagentCompletionDelivery>[0],
): void {
  seedSubagentCompletionDelivery(params);
  subagentRuns.set(params.subagent.runId, params.subagent);
}

export async function withSubagentCompletionWorkerState(
  run: (database: OpenClawStateDatabase) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawStateDatabase();
    await admitCompletionFixtureDatabase();
    try {
      await run(database);
    } finally {
      subagentRuns.clear();
    }
  });
}

export async function advanceRequesterWakeTime(
  milliseconds: number,
  resume?: () => void,
): Promise<void> {
  const settleRootWork = observeRootWork();
  try {
    resume?.();
    await vi.advanceTimersByTimeAsync(milliseconds);
  } finally {
    await settleRootWork();
  }
}

export function records() {
  const now = Date.now();
  const subagent = createSubagentRunRecord({
    runId: "completion-run",
    taskRunId: "original-run",
    childSessionIdentity: { sessionId: "session-id", lifecycleRevision: "session-revision" },
    requesterDisplayKey: "agent:main:main",
    requesterAgentId: "main",
    requesterOrigin: { channel: "discord", to: "channel:requester", accountId: "primary" },
    task: "finish the work",
    createdAt: now - 2_000,
    endedAt: now - 1_000,
    outcome: { status: "ok" },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "canonical result", capturedAt: now },
    delivery: {
      status: "in_progress",
      disposition: "session_queued",
      generation: 1,
      queueId: sha256Hex("completion:1"),
      windowStartedAt: now,
      deadlineAt: now + 30 * 60_000,
    },
  });
  return { subagent };
}

export function requesterWakeDriver(inputs: ReturnType<typeof records>[]) {
  const wake = vi.fn<
    SubagentLifecycleController["options"]["maybeWakeRequesterAfterAllChildrenSettled"]
  >(async () => {
    throw new Error("requester unavailable");
  });
  const warn = vi.fn();
  const controller = new SubagentLifecycleController({
    runs: subagentRuns,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: async () => 0,
    getLatestRunForChildSession: getLatestLiveSubagentRunByChildSessionKey,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    emitSubagentProgressEndedForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    confirmProvisionalKill: vi.fn(),
    callGateway: vi.fn(),
    captureSubagentCompletionReply: vi.fn(),
    runSubagentAnnounceFlow: vi.fn(),
    maybeWakeRequesterAfterAllChildrenSettled: wake,
    warn,
  });
  return {
    controller,
    wake,
    warn,
    [Symbol.dispose]: () => controller.clearRuntimeState(),
    async sweep() {
      const sweeper = createSubagentRegistrySweeper({
        runs: subagentRuns,
        resumedRuns: new Set(),
        clearPendingLifecycleError: vi.fn(),
        clearPendingLifecycleTimeout: vi.fn(),
        sweepPendingLifecycle: vi.fn(),
        completeSubagentRunWithRecovery: vi.fn(),
        getGatewayRecoveryRuntime: () => undefined,
        finalizeInterruptedSubagentRun: vi.fn(async () => 0),
        startSubagentAnnounceCleanupFlow: controller.startSubagentAnnounceCleanupFlow,
        completeCleanupBookkeeping: controller.completeCleanupBookkeeping,
        resumeRequesterSettleWake: controller.resumeRequesterSettleWake,
        resumePendingRequesterSettlements: controller.resumePendingRequesterSettlements,
        isCleanupOwnerCurrent: controller.isCleanupOwnerCurrent,
        isTerminalTailActive: controller.isTerminalTailActive,
        sessionEffectsHostCurrent: (entry) => controller.sessionEffectsHostCurrent(entry),
        shouldSuppressSessionEffects: (entry, effects) =>
          controller.shouldSuppressSessionEffects(entry, effects),
        discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
        shouldEmitEndedHookForRun: () => false,
        emitSubagentEndedHookForRun: vi.fn(async () => {}),
        callGateway: vi.fn(),
        cleanupCollectorLaunchResources: vi.fn(async () => true),
        runContextEngineSubagentEnded: vi.fn(async () => {}),
        notifyContextEngineSubagentEnded: vi.fn(async () => {}),
        retireSupersededRun: vi.fn(async () => {}),
        retireObligations: vi.fn(async () => {}),
        getRunsForChildSession: () => [],
        getRunsForCollectorGroup: () => [],
        warn,
      });
      const settleRootWork = observeRootWork();
      try {
        await sweeper.sweepOnce();
      } finally {
        await settleRootWork();
        await sweeper.reset();
      }
    },
    async run(entry = inputs[0]!.subagent) {
      const settleRootWork = observeRootWork();
      try {
        controller.resumeRequesterSettleWake(entry.runId, entry);
      } finally {
        await settleRootWork();
      }
      expect(wake).toHaveBeenCalled();
    },
  };
}

export async function observeRequesterOutcomePublication(
  cut: "rejected" | "committed",
  originalStateDir: string,
) {
  const completionStore = await import("./subagent-completion-admission.store.js");
  const settle = completionStore.mutateRequesterCompletionBatch;
  const reconciledBatches: string[][] = [];
  let retainedBeforePublication = false;
  const observed = vi
    .spyOn(completionStore, "mutateRequesterCompletionBatch")
    .mockImplementation((params) => {
      if (params.operation.kind !== "settle") {
        return settle(params);
      }
      if (params.committed) {
        reconciledBatches.push(params.entries.map((subagent) => subagent.runId));
      }
      return settle({
        ...params,
        onCommitted(receipt) {
          params.onCommitted?.(receipt);
          if (cut === "committed" && !retainedBeforePublication) {
            retainedBeforePublication = true;
            process.env.OPENCLAW_STATE_DIR = `${originalStateDir}/replacement-source`;
          }
        },
      });
    });
  return {
    reconciledBatches,
    get retainedBeforePublication() {
      return retainedBeforePublication;
    },
    restore: () => observed.mockRestore(),
  };
}

export function armRequesterWake(
  input: ReturnType<typeof records>,
  batchRunIds = [input.subagent.runId],
) {
  input.subagent.cleanupHandled = true;
  input.subagent.cleanupCompletedAt = Date.now();
  input.subagent.requesterSettleWake = {
    status: "pending",
    attemptCount: 0,
    rearmGeneration: 1,
    batchRunIds,
  };
  return input;
}
export function failedRecords(
  status: "cancelled" | "failed" | "timed_out",
  outcome: NonNullable<SubagentRunRecord["execution"]["outcome"]>,
) {
  const input = records();
  input.subagent.endedReason = status === "cancelled" ? "subagent-killed" : "subagent-error";
  input.subagent.execution.outcome = outcome;
  input.subagent.completion!.resultText = "original failure summary";
  return armRequesterWake(input);
}

export async function reopenCompletionFixtureOwners() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  subagentRuns.clear();
  const database = openOpenClawStateDatabase();
  for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
    subagentRuns.set(runId, entry);
  }
  return database;
}

export function currentCompletionRun(input: { subagent: SubagentRunRecord }): SubagentRunRecord {
  return expectDefined(subagentRuns.get(input.subagent.runId), "published completion run");
}

export function updateCompletionOwner(
  runId: string,
  update: (current: SubagentRunRecord) => SubagentRunRecord | null,
  options?: Pick<NonNullable<Parameters<typeof mutateSubagentRuns>[2]>, "context">,
): Promise<void> {
  return mutateSubagentRuns(
    [runId],
    (rows) => ({
      value: undefined,
      postimages: new Map([[runId, update(expectDefined(rows.get(runId), "completion owner"))]]),
    }),
    options,
  );
}

/** Fixture convenience; production callers use the guarded mutation owner directly. */
export function settleRequesterCompletionBatch(
  params: Omit<
    Parameters<typeof mutateRequesterCompletionBatch>[0],
    "operation" | "assertCurrent"
  > & {
    outcome?: SubagentAnnounceDeliveryResult;
    assertCurrent?: () => void;
  },
): ReturnType<typeof mutateRequesterCompletionBatch> {
  return mutateRequesterCompletionBatch({
    ...params,
    assertCurrent: params.assertCurrent ?? (() => {}),
    operation: params.outcome ? { kind: "settle", outcome: params.outcome } : { kind: "complete" },
  });
}
