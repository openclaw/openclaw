import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createGatewayRequestContext } from "../../../gateway/server-request-context.js";
import { makeContextParams } from "../../../gateway/server-request-context.test-support.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { resetHeartbeatEventsForTest } from "../../../infra/heartbeat-events.js";
import { loadPendingSessionDeliveries } from "../../../infra/session-delivery-queue-storage.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  blockSubagentCompletionDelivery,
  SubagentCompletionSourceChangedError,
  mutateRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import {
  admitCompletionFixtureDatabase,
  failedRecords,
  records,
  requesterWakeDriver,
  seedSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.test-helpers.js";
import {
  hasSubagentControllerInput,
  subagentCompletionSourceId,
} from "./subagent-controller-inputs.js";
import { loadPendingFinalDeliveryPayload } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  bindSubagentRunGatewayOwners,
  retryDeferredSubagentCompletionSource,
} from "./subagent-registry-gateway-owner.js";
import * as lifecycleCleanup from "./subagent-registry-lifecycle-cleanup.js";
import { getSubagentActivationRuns, subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import {
  createSubagentStoreRunFixture,
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  leasePendingAgentSteeringItems,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function publishCommittedRecords(row: SubagentRunRecord): void {
  seedSubagentCompletionDelivery({ subagent: row });
  subagentRuns.set(row.runId, row);
  publishSubagentRunsAfterAtomicStore(subagentRuns, [row.runId])();
}

function expectNoSystemEvents(database: ReturnType<typeof openOpenClawStateDatabase>) {
  expect(
    database.db
      .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
      .all(),
  ).toEqual([]);
}

const recoveryWarn = vi.hoisted(() => vi.fn());
vi.mock("../../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "agents/subagents" ? { ...logger, warn: recoveryWarn } : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let settleRootWork: ReturnType<typeof observeRootWork>;
const controllerInputs: SessionControllerInput[] = [];
vi.mock("../../../config/config.js", { spy: true });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-child-store-replaced-"));
  await resetSubagentRegistryForTests({ persist: false });
  vi.mocked(getRuntimeConfig).mockReturnValue({});
  settleRootWork = observeRootWork();
  publishSystemEventStoreResolver(() => "original-store");
});

afterEach(async () => {
  for (const input of controllerInputs) {
    retireSessionControllerInput(input);
  }
  await Promise.all(controllerInputs.map((input) => input.settlement.promise));
  controllerInputs.length = 0;
  await settleRootWork();
  await closeOpenClawStateDatabaseAsync();
  await resetSubagentRegistryForTests({ persist: false });
  publishSystemEventStoreResolver(undefined);
  resetHeartbeatEventsForTest();
  vi.mocked(getRuntimeConfig).mockReset();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("leaves yielded tasks with their owner until a final result needs store retirement", async () => {
  const { subagent } = records();
  subagent.requesterStorePath = "original-store";
  markSubagentRunPausedAfterYield({ entry: subagent });
  publishCommittedRecords(subagent);
  using runWorker = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");

  for (let publication = 0; publication < 3; publication++) {
    publishSystemEventStoreResolver(() => "replacement-store");
    await settleRootWork(true);
  }
  expect(runWorker).not.toHaveBeenCalled();
  expect(subagentRuns.isCompletionAuthorityRetired(subagent)).toBe(false);
  expect(loadSubagentRegistryFromSqlite().get(subagent.runId)).toMatchObject({
    pauseReason: "sessions_yield",
    delivery: { status: "pending" },
  });

  const completed = structuredClone(
    expectDefined(subagentRuns.get(subagent.runId), "yielded task"),
  );
  delete completed.pauseReason;
  completed.execution.outcome = { status: "ok" };
  completed.completion = {
    required: true,
    resultText: "retained final result",
    terminalReply: { disposition: "visible", text: "retained final result" },
  };
  publishCommittedRecords(completed);
  publishSystemEventStoreResolver(() => "replacement-store");
  publishSystemEventStoreResolver(() => "original-store");
  expect(subagentRuns.isCompletionAuthorityRetired(completed)).toBe(true);
  await settleRootWork(true);
  expect(loadSubagentRegistryFromSqlite().get(subagent.runId)).toMatchObject({
    completion: { resultText: "retained final result" },
    delivery: { status: "suspended", disposition: "intentional_non_delivery" },
  });
});

it.each([false, true])(
  "suspends an original-store child that completes after replacement without a new alert (overlapping new-store wake: %s)",
  async (overlappingWake) => {
    const { subagent } = records();
    const now = Date.now();
    let replacementWake: typeof subagent.requesterSettleWake;
    if (overlappingWake) {
      subagent.execution.endedAt = now + 2_000;
    }
    subagent.requesterStorePath = "original-store";
    subagent.delivery = {
      status: "pending",
      payload: loadPendingFinalDeliveryPayload(subagent),
    };
    subagent.requesterSettleWake = overlappingWake
      ? { status: "pending", attemptCount: 0 }
      : {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: [subagent.runId],
        };
    const running = structuredClone(subagent);
    running.execution = { status: "running", startedAt: subagent.createdAt };
    running.completion = { required: true };
    const database = openOpenClawStateDatabase();
    publishCommittedRecords(running);
    publishSystemEventStoreResolver(() => "replacement-store");
    expect(subagentRuns.get(subagent.runId)?.execution.status).toBe("running");

    if (overlappingWake) {
      vi.setSystemTime(now + 1_000);
      const { subagent: replacement } = records();
      replacement.taskRunId = "replacement-task-run";
      replacement.childSessionKey = "agent:main:subagent:replacement";
      replacement.createdAt = now + 1_000;
      replacement.execution.endedAt = now + 1_500;
      // A failed sibling retains its wake without queuing a success-expiry alert.
      replacement.execution.outcome = { status: "error", error: "replacement failed" };
      replacement.runId = "replacement-run";

      replacement.requesterStorePath = "replacement-store";
      replacement.delivery = { status: "pending" };
      replacement.requesterSettleWake = { status: "pending", attemptCount: 0 };
      publishCommittedRecords(replacement);
      expect(
        await blockSubagentCompletionDelivery({
          subagent: expectDefined(subagentRuns.get(replacement.runId), "new-store child"),
          reason: "completion delivery failed",
        }),
      ).toBe(true);
      replacementWake = structuredClone(subagentRuns.get(replacement.runId)?.requesterSettleWake);
      expect(replacementWake).toMatchObject({ status: "pending" });
      vi.setSystemTime(now + 2_000);
    }

    publishCommittedRecords(subagent);
    const settledEntry = expectDefined(subagentRuns.get(subagent.runId), "late terminal child");
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled({
        isSourceCurrent: () => true,
        requesterSessionKey: subagent.requesterSessionKey,
        settledEntry,
        transitionBatch: () => {
          throw new Error("a replaced store must not admit a delivery attempt");
        },
        completeBatch: async (batch, _generation, outcome, onCommitted) => {
          await mutateRequesterCompletionBatch({
            entries: batch,
            operation: {
              kind: "settle",
              outcome: expectDefined(outcome, "store replacement disposition"),
            },
            assertCurrent: () => {
              if (!batch.every((entry) => subagentRuns.get(entry.runId) === entry)) {
                throw new SubagentCompletionSourceChangedError(
                  "Subagent completion owner changed before settlement",
                );
              }
            },
          });
          await onCommitted?.();
        },
      }),
    ).toBe(false);
    if (overlappingWake) {
      expect(loadSubagentRegistryFromSqlite().get("replacement-run")?.requesterSettleWake).toEqual(
        replacementWake,
      );
    }
    expectNoSystemEvents(database);
    expect(loadSubagentRegistryFromSqlite().get(subagent.runId)).toMatchObject({
      completion: { resultText: "canonical result" },
      delivery: {
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
      },
    });
  },
);

it("keeps an observed late-result store retirement after the original selector returns", async () => {
  const input = records();
  const requesterStorePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  await upsertSessionEntryCore(
    {
      agentId: "main",
      storePath: requesterStorePath,
      sessionKey: input.subagent.requesterSessionKey,
    },
    { sessionId: "store-retirement-requester", updatedAt: Date.now() },
  );
  input.subagent.requesterStorePath = requesterStorePath;
  publishSystemEventStoreResolver(() => requesterStorePath);
  input.subagent.delivery = { status: "pending" };
  input.subagent.execution.outcome = { status: "error" };
  input.subagent.endedReason = SUBAGENT_ENDED_REASON_ERROR;
  const executionBefore = structuredClone(input.subagent.execution);
  const running = structuredClone(input.subagent);
  running.execution = { status: "running", startedAt: running.createdAt };
  running.endedReason = undefined;
  running.completion = { required: true };
  const database = openOpenClawStateDatabase();
  publishCommittedRecords(running);
  publishSystemEventStoreResolver(() => "replacement-store");

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
    expect(driver.controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
    const announce = await entered.promise;
    expect(announce.isCompletionDeliveryAllowed?.()).toBe(false);
    publishSystemEventStoreResolver(() => requesterStorePath);
    expect(announce.isCompletionDeliveryAllowed?.()).toBe(false);
  } finally {
    release.resolve();
    await settleRootWork(true);
    driver.controller.clearRuntimeState();
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
  expectNoSystemEvents(database);
});

it.each(["same", "restore", "unknown retry", "failed", "pending acknowledgment"] as const)(
  "keeps automatic child notification disposition through store publication: %s",
  async (change) => {
    const { subagent } =
      change === "failed" ? failedRecords("failed", { status: "error" }) : records();
    const unknownStore = change === "unknown retry";
    subagent.requesterStorePath = unknownStore ? undefined : "original-store";
    subagent.controllerStorePath = unknownStore ? undefined : "original-store";
    subagent.cleanupCompletedAt = undefined;
    subagent.delivery = {
      status: "pending",
      payload: loadPendingFinalDeliveryPayload(subagent),
    };
    const executionBefore = structuredClone(subagent.execution);
    const source = reserveSessionControllerSource(subagent.requesterSessionKey, {
      reservationId: subagentCompletionSourceId(subagent),
      policy: { mode: "followup" },
      target: captureSessionTarget({
        storeScope: "original-store",
        sessionKey: subagent.requesterSessionKey,
        agentId: subagent.requesterAgentId,
        incarnation: "requester-session",
      }),
    });
    controllerInputs.push(source);
    expect(hasSubagentControllerInput(subagent)).toBe(true);
    const database = openOpenClawStateDatabase();
    seedSubagentCompletionDelivery({ subagent });
    const receipt = expectDefined(
      loadSubagentRegistryFromSqlite().get(subagent.runId)?.delivery,
      "persisted notification receipt",
    );
    subagentRuns.set(subagent.runId, subagent);
    await initSubagentRegistry();
    using retireNotifications = vi.spyOn(lifecycleCleanup, "suspendReplacedStoreNotifications");
    if (change === "unknown retry") {
      await admitCompletionFixtureDatabase();
      database.db.exec(
        "CREATE TRIGGER reject_store_retirement BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'retirement write rejected'); END",
      );
    }
    if (change === "pending acknowledgment") {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let observed = false;
      let settling: Promise<void> | undefined;
      const held = probe.command(stateWorker, async (command, executeOptions, scope) => {
        const result = await scope.execute(command, executeOptions);
        if (command.type === "sessionDelivery.mutateSubagentCompletion") {
          observed = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      });
      try {
        publishSystemEventStoreResolver(() => "replacement-store");
        publishSystemEventStoreResolver(() => "original-store");
        expect(subagentRuns.isCompletionAuthorityRetired(subagent)).toBe(true);
        settling = settleRootWork(true);
        await Promise.race([entered.promise, settling]);
        expect(observed).toBe(true);
        expect(() => subagentRuns.runWithCompletionAuthority(subagent, () => "send")).toThrow(
          /store was retired/,
        );
        expect(() =>
          subagentRuns.runWithCompletionBatchAuthority([subagent], () => "send"),
        ).toThrow(/store was retired/);
        const successor = { ...structuredClone(subagent), runId: "replacement-completion" };
        subagentRuns.transferCompletionAuthority(subagent, successor);
        expect(() => subagentRuns.runWithCompletionAuthority(successor, () => "send")).toThrow(
          /store was retired/,
        );
        expect(subagentRuns.isCompletionAuthorityRetired(subagent)).toBe(true);
        expect(subagentRuns.isCompletionAuthorityRetired(successor)).toBe(true);
      } finally {
        release.resolve();
        await settling;
        await settleRootWork(true);
        held.mockRestore();
      }
      expect(subagentRuns.get(subagent.runId)?.delivery).toMatchObject({
        status: "suspended",
        disposition: "intentional_non_delivery",
      });
      expect(subagentRuns.isCompletionAuthorityRetired(subagent)).toBe(true);
    } else if (change === "restore") {
      for (let boot = 0; boot < 2; boot++) {
        await resetSubagentRegistryForTests({ persist: false });
        publishSystemEventStoreResolver(() => "replacement-store");
        await initSubagentRegistry();
        const context = createGatewayRequestContext(makeContextParams());
        context.resolveGatewayContext = () => context;
        await activateSubagentRegistry(() => context);
        await settleRootWork(true);
      }
    } else {
      publishSystemEventStoreResolver(() =>
        change === "same" || unknownStore ? "original-store" : "replacement-store",
      );
    }
    publishSystemEventStoreResolver(() => "original-store");
    if (change === "unknown retry") {
      const context = createGatewayRequestContext(makeContextParams());
      context.resolveGatewayContext = () => context;
      await activateSubagentRegistry(() => context);
      try {
        expect(retireNotifications).toHaveBeenCalled();
        await expect(retireNotifications.mock.results[0]?.value).rejects.toThrow(
          "retirement write rejected",
        );
        await expect(settleRootWork(true)).rejects.toMatchObject({
          name: "AggregateError",
          message: "Failed to settle subagent cleanup roots",
          errors: [
            {
              name: "SubagentRegistryWriteError",
              outcome: "not-committed",
              cause: { message: "retirement write rejected" },
            },
          ],
        });
        expect(loadSubagentRegistryFromSqlite().get(subagent.runId)?.delivery).toEqual(receipt);
        expect(() => subagentRuns.runWithCompletionAuthority(subagent, () => "send")).toThrow(
          /store was retired/,
        );
      } finally {
        database.db.exec("DROP TRIGGER reject_store_retirement");
      }
      // The active registry owns retry even when the selector never publishes again.
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await settleRootWork(true);
    const persisted = loadSubagentRegistryFromSqlite().get(subagent.runId);
    if (unknownStore) {
      expect(persisted?.requesterStorePath).toBeUndefined();
      expect(persisted?.controllerStorePath).toBeUndefined();
    }
    expect(persisted?.completion?.resultText).toBe(subagent.completion?.resultText);
    expect(persisted?.execution).toEqual(executionBefore);
    expectNoSystemEvents(database);
    if (change !== "same") {
      expect(persisted?.delivery).toMatchObject({
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
        payload: receipt.payload,
      });
      expect(persisted?.requesterSettleWake).toBeUndefined();
    }
    expect(hasSubagentControllerInput(subagent)).toBe(change === "same");
    const lease = await leasePendingAgentSteeringItems({
      requesterSessionKey: subagent.requesterSessionKey,
      leaseId: "after-store-publication",
    });
    if (change === "same") {
      expect(lease?.prompt).toContain("canonical result");
    } else {
      expect(lease).toBeUndefined();
    }
  },
);

it.each([false, true])(
  "durably settles missing completion sources across two restarts (failed write: %s)",
  async (failWrite) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { session: { store: state.path("sessions.json") } };
      setRuntimeConfigSnapshot(cfg);
      vi.mocked(getRuntimeConfig).mockReturnValue(cfg);
      const entries = ["successful", "interrupted", "quiet", "delivered"].map((kind) =>
        createSubagentStoreRunFixture({
          runId: `legacy-${kind}`,
          childSessionKey: `agent:main:subagent:legacy-${kind}`,
          expectsCompletionMessage: kind !== "quiet",
          requesterStorePath: ["quiet", "delivered"].includes(kind) ? "old" : "current",
          ...(kind === "delivered"
            ? {
                delivery: {
                  status: "delivered",
                  disposition: "delivered",
                  deliveredAt: 260,
                  announcedAt: 260,
                },
              }
            : {}),
          ...(kind === "interrupted"
            ? {
                execution: {
                  status: "terminal",
                  endedAt: 250,
                  outcome: { status: "error", error: "Gateway restarted" },
                },
              }
            : {}),
        }),
      );
      const wake = { status: "pending", attemptCount: 0 } as const;
      const delivered = { status: "delivered", deliveredAt: 260, announcedAt: 260 } as const;
      const legacyStates: Partial<SubagentRunRecord>[] = [
        { requesterSettleWake: wake, cleanupCompletedAt: 300, delivery: delivered },
        { requesterSettleWake: wake, cleanupCompletedAt: 300 },
        {
          requesterSettleWake: wake,
          delivery: { status: "suspended", disposition: "permanent_failure" },
        },
        { execution: { status: "terminal", endedAt: 250 } },
        {
          pauseReason: "sessions_yield",
          execution: { status: "terminal", endedAt: 250 },
          requesterStorePath: "old",
        },
        {
          pauseReason: "sessions_yield",
          execution: { status: "terminal", endedAt: 250 },
          requesterStorePath: undefined,
          delivery: delivered,
        },
        {
          pauseReason: "sessions_yield",
          execution: { status: "terminal", endedAt: 250 },
          requesterSettleWake: { ...wake, pauseNotice: { acknowledgment: "Paused" } },
        },
        {
          pauseReason: "sessions_yield",
          execution: { status: "terminal", endedAt: 250 },
          requesterSettleWake: { ...wake, requesterYieldBatch: true, rearmGeneration: 1 },
        },
        {
          runId: "announce:requester-settle:main:legacy:yield-1",
          requesterSettleWake: {
            status: "dispatching",
            attemptCount: 1,
            requesterYieldBatch: true,
            rearmGeneration: 1,
          },
        },
        {
          runId: "announce:requester-settle:main:legacy:yield-2",
          execution: { status: "running", endedAt: 250, outcome: { status: "ok" } },
          cleanupCompletedAt: 300,
          delivery: delivered,
        },
      ];
      for (const [index, overrides] of legacyStates.entries()) {
        const runId = overrides.runId ?? `legacy-state-${index}`;
        const entry = createSubagentStoreRunFixture({
          runId,
          childSessionKey: `agent:main:subagent:legacy-state-${index}`,
          requesterStorePath: "current",
          completionTarget: "parent",
          ...overrides,
        });
        if (entry.requesterSettleWake?.requesterYieldBatch) {
          entry.requesterSettleWake.batchRunIds = [runId];
        }
        entries.push(entry);
      }
      saveSubagentRegistryChangesToSqlite(
        new Map(entries.map((entry) => [entry.runId, entry])),
        entries.map((entry) => entry.runId),
      );
      const restart = async () => {
        await resetSubagentRegistryForTests({ persist: false });
        rotateAgentEventLifecycleGeneration();
        await initSubagentRegistry();
        publishSystemEventStoreResolver(() => "current");
        const context = createContext();
        context.resolveGatewayContext = () => context;
        await bindSubagentRunGatewayOwners({
          runs: subagentRuns,
          entries: [...getSubagentActivationRuns(subagentRuns)],
          resumedRuns: new Set(),
          getGatewayContextResolver: () => context.resolveGatewayContext,
          onRecovered: () => {},
        });
      };
      onTestFinished(() => publishSystemEventStoreResolver(undefined));
      if (failWrite) {
        await admitCompletionFixtureDatabase();
        openOpenClawStateDatabase().db.exec(`CREATE TRIGGER reject_missing_source_settlement
          BEFORE UPDATE ON subagent_runs WHEN NEW.run_id = 'legacy-state-0'
          BEGIN SELECT RAISE(ABORT, 'temporary completion settlement failure'); END`);
      }
      recoveryWarn.mockClear();
      await restart();
      expect(recoveryWarn).toHaveBeenCalledTimes(failWrite ? 1 : 0);
      if (failWrite) {
        const unsettled = [...loadSubagentRegistryFromSqlite().values()].filter(
          (entry) => !entry.suppressCompletionDelivery,
        );
        expect(unsettled.map((entry) => entry.runId)).toEqual(["legacy-state-0"]);
        openOpenClawStateDatabase().db.exec("DROP TRIGGER reject_missing_source_settlement");
        await retryDeferredSubagentCompletionSource(
          expectDefined(subagentRuns.get(unsettled[0]!.runId), "retryable completion"),
        );
      }
      expect(await loadPendingSessionDeliveries(captureOpenClawStateWorkerContext())).toEqual([]);
      recoveryWarn.mockClear();
      await restart();
      expect(recoveryWarn).not.toHaveBeenCalledWith(
        "subagent completion authority was not restored",
        expect.anything(),
      );
      const settled = loadSubagentRegistryFromSqlite();
      for (const entry of entries) {
        expect(settled.get(entry.runId)?.requesterSettleWake).toBeUndefined();
        expect(settled.get(entry.runId)).toMatchObject({
          execution: entry.execution,
          completion: entry.completion,
          suppressCompletionDelivery: true,
          delivery:
            entry.delivery?.status === "delivered"
              ? entry.delivery
              : {
                  status: entry.expectsCompletionMessage ? "failed" : "not_required",
                  disposition: "permanent_failure",
                  lastError: expect.stringContaining("original operator source"),
                },
        });
      }
    });
  },
);
