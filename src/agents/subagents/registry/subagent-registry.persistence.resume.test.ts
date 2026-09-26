import { setImmediate as nextTask } from "node:timers/promises";
// Subagent registry persistence-resume tests cover restoring SQLite-backed child runs.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  activateSubagentPersistenceRegistry,
  announceSpy,
  closeSubagentPersistenceFixtureDatabases,
  createSubagentPersistenceRuntime,
  listFixtureAgentDatabases,
  resetSubagentPersistenceGatewayCalls,
} from "./subagent-registry.persistence-fixture.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { listOpenClawAgentDatabasesForTest as listSeedAgentDatabases } from "../../../state/openclaw-agent-db.test-support.js";
import { closeOpenClawStateDatabaseForTest as closeSeedStateDatabase } from "../../../state/openclaw-state-db.js";
import "./subagent-registry.mocks.shared.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { registerSubagentDismissedRetentionCases } from "./subagent-registry.persistence.retention.test-support.js";
import {
  gateSubagentRequesterSettlement,
  observeSubagentRequesterWake,
  settleSubagentRegistryPersistenceWork,
  withSubagentRegistryPersistenceState,
  createDeliveredWake,
  createRestoredRequesterWakeRuns,
  createOrphanedRequiredDelivery,
  writeChildSession,
} from "./subagent-registry.persistence.test-support.js";
import { registerStaleRequesterWakeBatchTests } from "./subagent-registry.persistence.wake.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type WakeRequester = typeof maybeWakeRequesterAfterAllChildrenSettled;
type WakeParams = Parameters<WakeRequester>[0];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let mod: typeof import("./subagent-registry.test-helpers.js");
let callGatewayModule: typeof import("../../../gateway/call.js");
let agentEventsModule: typeof import("../../../infra/agent-events.js");
let requesterSettleModule: typeof import("../announce/subagent-announce.requester-settle-wake.js");
let registryConfigModule: typeof import("../../../config/config.js");
let registrySessionCleanupModule: typeof import("../../../test-utils/session-state-cleanup.js");
let registryAgentDbTestModule: typeof import("../../../state/openclaw-agent-db.test-support.js");
let registryStateDbModule: typeof import("../../../state/openclaw-state-db.js");
let bindGatewayContextResolver: typeof import("../../../plugins/runtime/gateway-request-scope.js").bindGatewayContextResolver;
let getGatewayContextResolver: typeof import("../../../plugins/runtime/gateway-request-scope.js").getGatewayContextResolver;
let getGatewayToolCallerIdentity: typeof import("../../tools/gateway-caller-context.js").getGatewayToolCallerIdentity;
let withGatewayToolCallerIdentity: typeof import("../../tools/gateway-caller-context.js").withGatewayToolCallerIdentity;
let observeRootWork: typeof import("./subagent-registry.browser-cleanup.test-support.js").observeRootWork;
let settleOwnedWork: ReturnType<typeof observeRootWork> | undefined;

const readPersistedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);

describe("subagent registry persistence resume", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ bindGatewayContextResolver, getGatewayContextResolver } =
      await import("../../../plugins/runtime/gateway-request-scope.js"));
    ({ getGatewayToolCallerIdentity, withGatewayToolCallerIdentity } =
      await import("../../tools/gateway-caller-context.js"));
    mod = await import("./subagent-registry.test-helpers.js");
    callGatewayModule = await import("../../../gateway/call.js");
    agentEventsModule = await import("../../../infra/agent-events.js");
    registryStateDbModule = await import("../../../state/openclaw-state-db.js");
    requesterSettleModule = await import("../announce/subagent-announce.requester-settle-wake.js");
    registryConfigModule = await import("../../../config/config.js");
    registryAgentDbTestModule = await import("../../../state/openclaw-agent-db.test-support.js");
    registrySessionCleanupModule = await import("../../../test-utils/session-state-cleanup.js");
    ({ observeRootWork } = await import("./subagent-registry.browser-cleanup.test-support.js"));
  });

  beforeEach(() => {
    settleOwnedWork = observeRootWork();
    setRuntimeConfigSnapshot({});
    registryConfigModule.setRuntimeConfigSnapshot({});
    announceSpy.mockClear();
    resetSubagentPersistenceGatewayCalls(callGatewayModule.callGateway);
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(agentEventsModule.onAgentEvent)
      .mockReset()
      .mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    try {
      await settleOwnedWork?.();
    } finally {
      settleOwnedWork = undefined;
      vi.restoreAllMocks();
      clearRuntimeConfigSnapshot();
      registryConfigModule.clearRuntimeConfigSnapshot();
    }
  });

  const withRegistryState = <T>(run: (stateDir: string) => Promise<T>) => {
    const stateDir = tempDirs.make("openclaw-subagent-");
    return withSubagentRegistryPersistenceState(
      {
        stateDir,
        resetRegistry: () => mod.resetSubagentRegistryForTests({ persist: false }),
        settleOwnedWork: () => settleOwnedWork?.(true),
        closeDatabases: () =>
          closeSubagentPersistenceFixtureDatabases({
            stateDir,
            cleanupSessionState: registrySessionCleanupModule.cleanupSessionStateForTest,
            listAgentDatabases: registryAgentDbTestModule.listOpenClawAgentDatabasesForTest,
            closeStateDatabase: registryStateDbModule.closeOpenClawStateDatabaseForTest,
          }),
      },
      () => run(stateDir),
    );
  };

  it.each([
    { name: "announcing", expectsCompletionMessage: true },
    { name: "nonannouncing", expectsCompletionMessage: false },
    { name: "unspecified completion" },
    { name: "collector", expectsCompletionMessage: false, collect: true },
  ])("preserves the registered parent turn through SQLite reopen: $name", async (options) => {
    await withRegistryState(async () => {
      vi.mocked(callGatewayModule.callGateway).mockResolvedValue({ status: "pending" });
      const { name, ...registration } = options;
      const childSessionKey = "agent:main:subagent:parent-association";
      await mod.registerSubagentRun({
        runId: "child-parent-association",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterTurnRunId: "  parent-turn  ",
        requesterDisplayKey: "main",
        task: name,
        cleanup: "keep",
        ...registration,
      });
      const expected = {
        requesterTurnRunId: "parent-turn",
        completion: { required: registration.expectsCompletionMessage === true },
        delivery: {
          status: registration.expectsCompletionMessage === false ? "not_required" : "pending",
        },
      };
      const registered = mod.getSubagentRunByChildSessionKey(childSessionKey);
      expect(registered).toMatchObject(expected);
      expect(registered?.expectsCompletionMessage).toBe(registration.expectsCompletionMessage);
      registryStateDbModule.closeOpenClawStateDatabaseForTest();
      const restored = readPersistedRun("child-parent-association");
      expect(restored).toMatchObject(expected);
      expect(restored?.expectsCompletionMessage).toBe(registration.expectsCompletionMessage);
    });
  });

  it("resumes a persisted run from canonical SQLite state", async () => {
    await withRegistryState(async (stateDir) => {
      const run = createSubagentRunRecord({
        runId: "run-1",
        childSessionKey: "agent:main:subagent:test",
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
        task: "do the thing",
        execution: { status: "running" },
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      await writeChildSession(stateDir, run.childSessionKey, "sess-test");

      mod.initSubagentRegistry();
      activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);

      await settleSubagentRegistryPersistenceWork(() => settleOwnedWork?.(true));
      expect(announceSpy).toHaveBeenCalled();
      const announce = (announceSpy.mock.calls as unknown as Array<[unknown]>).at(-1)?.[0] as
        | {
            childRunId?: string;
            requesterOrigin?: { channel?: string; accountId?: string };
            outcome?: { status?: string };
          }
        | undefined;
      expect(announce).toMatchObject({
        childRunId: "run-1",
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
        outcome: { status: "ok" },
      });
      expect(mod.listSubagentRunsForRequester("agent:main:main")[0]).toMatchObject({
        childSessionKey: run.childSessionKey,
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
      });
      expect(
        listFixtureAgentDatabases(listSeedAgentDatabases, stateDir),
        "seed session write acquired an agent handle",
      ).toHaveLength(1);
      expect(
        listFixtureAgentDatabases(
          registryAgentDbTestModule.listOpenClawAgentDatabasesForTest,
          stateDir,
        ),
        "resumed completion timing acquired a post-reset agent handle",
      ).toHaveLength(1);
    });
  });

  it.each([
    { label: "successful", status: "ok" as const },
    { label: "timed-out", status: "timeout" as const },
  ])("retries pending $label child delivery after restart", async ({ label, status }) => {
    await withRegistryState(async (stateDir) => {
      const runId = `run-pending-${label}-delivery`;
      const childSessionKey = `agent:main:subagent:pending-${label}-delivery`;
      const run = createSubagentRunRecord({
        runId,
        requesterTurnRunId: "run-requester",
        childSessionKey,
        task: "deliver before waking requester",
        createdAt: 100,
        endedReason: "subagent-complete",
        startedAt: 110,
        endedAt: 200,
        outcome: { status },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: 200 },
        delivery: {
          status: "pending",
          payload: {
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            childSessionKey,
            childRunId: runId,
            task: "deliver before waking requester",
            startedAt: 110,
            endedAt: 200,
            outcome: { status },
            expectsCompletionMessage: true,
          },
        },
        cleanupHandled: false,
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      await writeChildSession(stateDir, run.childSessionKey, `sess-pending-${label}-delivery`);

      mod.initSubagentRegistry();
      activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);

      await settleSubagentRegistryPersistenceWork(() => settleOwnedWork?.(true));
      expect(announceSpy).toHaveBeenCalled();
      expect(announceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ childRunId: runId, outcome: { status } }),
      );
      expect(mod.getSubagentRunByRunId(runId)?.execution.outcome).toEqual({ status });
    });
  });

  it("replays one required completion after restart without the child session", async () => {
    await withRegistryState(async () => {
      const run = createOrphanedRequiredDelivery("pending");
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      const settlement = gateSubagentRequesterSettlement(
        requesterSettleModule.maybeWakeRequesterAfterAllChildrenSettled,
      );
      vi.spyOn(
        requesterSettleModule,
        "maybeWakeRequesterAfterAllChildrenSettled",
      ).mockImplementation(settlement.run);
      try {
        mod.initSubagentRegistry();
        activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);
        await settlement.waitForCalls(1);
        expect(settlement.run, "replay reached requester settlement").toHaveBeenCalledOnce();
        expect(announceSpy, "replayed announcement delivered").toHaveBeenCalledOnce();
        expect(readPersistedRun(run.runId), "delivered row awaits real settlement").toMatchObject({
          delivery: { status: "delivered" },
          requesterSettleWake: { retireAfterSettle: true },
        });
        expect(announceSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            childSessionKey: run.childSessionKey,
            childRunId: run.runId,
            requesterSessionKey: "agent:main:main",
            roundOneReply: "canonical final reply",
            terminalReply: run.completion?.terminalReply,
            outcome: { status: "ok" },
          }),
        );
        await settlement.release();
        expect(settlement.run).toHaveBeenCalledOnce();
        expect(
          loadSubagentRegistryFromSqlite().has(run.runId),
          "settlement retired delivered row",
        ).toBe(false);
        await settleSubagentRegistryPersistenceWork(() => settleOwnedWork?.(true));

        mod.resetSubagentRegistryForTests({ persist: false });
        mod.initSubagentRegistry();
        activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);
        await settleSubagentRegistryPersistenceWork(() => settleOwnedWork?.(true));
        expect(announceSpy, "retired completion is not replayed again").toHaveBeenCalledOnce();
      } finally {
        await settlement.release();
      }
    });
  });

  it.each([
    "permanent rejection",
    "inactive drain error",
    "restart admission",
    "restart reactivation",
    "restart before deadline",
    "restart before activation",
    "restart throwing source",
  ] as const)("settles or preserves a delivered wake after %s", async (failure) => {
    const admission = await import("../../../process/gateway-work-admission.js");
    const restarting = failure.startsWith("restart");
    const waitingForActivation = failure === "restart before activation";
    let firstGatewayOpen = true;
    const firstGateway = {
      resolveGatewayContext: () => (firstGatewayOpen ? (firstGateway as never) : undefined),
    };
    const replacementGateway = { resolveGatewayContext: () => replacementGateway as never };
    if (restarting) {
      vi.useFakeTimers();
    }
    try {
      await withRegistryState(async () => {
        const endedAt = Date.now();
        const run = createDeliveredWake("run-rejected-requester-wake", {
          status: restarting && !waitingForActivation ? "dispatching" : "pending",
          attemptCount: waitingForActivation ? 2 : restarting ? 1 : 0,
          ...(restarting ? { replayCount: 1, nextAttemptAt: endedAt + 30_000 } : {}),
          batchRunIds: ["run-rejected-requester-wake"],
          requesterYieldBatch: true,
          afterRequesterYield: true,
          rearmGeneration: 1,
        });
        const wakeRequester = vi.fn<WakeRequester>(async (params) => {
          if (!restarting) {
            throw failure === "inactive drain error"
              ? new admission.GatewayDrainingError()
              : new Error("requester wake rejected before attempt admission");
          }
          expect(getGatewayContextResolver(params.settledEntry!)?.()).toBe(replacementGateway);
          await params.completeBatch(
            [params.settledEntry],
            run.requesterSettleWake?.rearmGeneration,
            {
              delivered: true,
              path: "direct",
            },
          );
          return true;
        });
        vi.spyOn(
          requesterSettleModule,
          "maybeWakeRequesterAfterAllChildrenSettled",
        ).mockImplementation(wakeRequester);
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

        mod.initSubagentRegistry();
        if (restarting) {
          mod.activateSubagentRegistry(() => firstGateway as never);
        } else {
          activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);
        }
        if (failure === "restart throwing source") {
          bindGatewayContextResolver(
            mod.getSubagentRunByRunId(run.runId)!,
            await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: run.requesterSessionKey,
                gatewayContextResolver: () => {
                  if (!firstGatewayOpen) {
                    throw new Error("retired source");
                  }
                  return firstGateway as never;
                },
              },
              () => getGatewayToolCallerIdentity()?.gatewayContextResolver,
            ),
          );
        }

        if (restarting) {
          // The earlier delivery released its root; the real deadline timer must
          // cross fresh admission rather than inheriting live requester authority.
          const previousWork = settleOwnedWork;
          settleOwnedWork = undefined;
          await previousWork?.();
          admission.markGatewayRestartDraining();
          if (failure !== "restart before deadline" && !waitingForActivation) {
            await vi.advanceTimersByTimeAsync(30_000);
          }
          expect(wakeRequester).not.toHaveBeenCalled();
          expect(mod.getSubagentRunByRunId(run.runId)?.requesterSettleWake).toEqual(
            run.requesterSettleWake,
          );
          registryStateDbModule.closeOpenClawStateDatabaseForTest();
          closeSeedStateDatabase();
          const persisted = readPersistedRun(run.runId);
          expect(persisted?.requesterSettleWake).toEqual(run.requesterSettleWake);
          expect(persisted?.requesterTurnRunId).toBeUndefined();

          const retiredRun = mod.getSubagentRunByRunId(run.runId)!;
          const retiredResolver = getGatewayContextResolver(retiredRun);
          firstGatewayOpen = false;
          if (failure === "restart admission") {
            mod.resetSubagentRegistryForTests({ persist: false });
          }
          admission.resetGatewayWorkAdmission();
          settleOwnedWork = observeRootWork();
          if (waitingForActivation) {
            await vi.advanceTimersByTimeAsync(30_000);
            expect(wakeRequester).not.toHaveBeenCalled();
            expect(readPersistedRun(run.runId)?.requesterSettleWake).toEqual(
              run.requesterSettleWake,
            );
          }
          mod.initSubagentRegistry();
          mod.activateSubagentRegistry(() => replacementGateway as never);
          const recoveredRun = mod.getSubagentRunByRunId(run.runId);
          expect(recoveredRun).not.toBe(retiredRun);
          mod.activateSubagentRegistry(() => replacementGateway as never);
          expect(mod.getSubagentRunByRunId(run.runId)).toBe(recoveredRun);
          expect(retiredResolver?.()).toBeUndefined();
          await mod.testing.runSweeperTickForTests();
          await vi.advanceTimersByTimeAsync(failure === "restart before deadline" ? 30_000 : 0);
        }
        await settleSubagentRegistryPersistenceWork(() => settleOwnedWork?.(true));
        expect(wakeRequester).toHaveBeenCalledOnce();
        const restored = readPersistedRun(run.runId);
        expect(restored?.delivery).toMatchObject({ status: "delivered" });
        expect(restored?.requesterSettleWake).toBeUndefined();
        await mod.testing.sweepOnceForTests();
        expect(wakeRequester).toHaveBeenCalledOnce();
      });
    } finally {
      admission.resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it.each([
    { order: "replacement-first", runCount: 1 },
    { order: "old-finally-first", runCount: 1 },
    { order: "before-activation", runCount: 1 },
    { order: "replacement-first", runCount: 3 },
  ] as const)(
    "fences outstanding wake work across forced restart: $order / $runCount rows",
    async ({ order, runCount }) => {
      const admission = await import("../../../process/gateway-work-admission.js");
      const oldDone = createDeferredCore<boolean>();
      const replacementDone = createDeferredCore();
      const oldParams: WakeParams[] = [];
      let oldFinished = 0;
      let firstGatewayOpen = true;
      const firstGateway = {
        resolveGatewayContext: () => (firstGatewayOpen ? (firstGateway as never) : undefined),
      };
      const replacementGateway = { resolveGatewayContext: () => replacementGateway as never };
      vi.useFakeTimers();
      try {
        await withRegistryState(async () => {
          try {
            const runs = Array.from({ length: runCount }, (_, index) => {
              const runId = `run-outstanding-wake-${index}`;
              return {
                ...createDeliveredWake(runId, {
                  status: "pending",
                  attemptCount: 2,
                  batchRunIds: [runId],
                  requesterYieldBatch: true,
                  afterRequesterYield: true,
                  rearmGeneration: 1,
                }),
                requesterSessionKey: `agent:main:requester-${index}`,
              };
            });
            const { run: wakeRequester, waitForCalls } = observeSubagentRequesterWake(
              async (params) => {
                if (getGatewayContextResolver(params.settledEntry!)?.() === firstGateway) {
                  oldParams.push(params);
                  await params.transitionBatch([params.settledEntry], {
                    ...params.settledEntry.requesterSettleWake!,
                    status: "dispatching",
                    attemptCount: 3,
                  });
                  const result = await oldDone.promise;
                  await params.completeBatch([params.settledEntry], 1, {
                    delivered: false,
                    path: "direct",
                    disposition: "retryable",
                    error: "completion agent did not produce a visible reply",
                  });
                  oldFinished++;
                  return result;
                }
                await replacementDone.promise;
                expect(getGatewayContextResolver(params.settledEntry!)?.()).toBe(
                  replacementGateway,
                );
                await params.completeBatch([params.settledEntry], 1, {
                  delivered: true,
                  path: "direct",
                });
                return true;
              },
            );
            vi.spyOn(
              requesterSettleModule,
              "maybeWakeRequesterAfterAllChildrenSettled",
            ).mockImplementation(wakeRequester);
            saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));
            mod.initSubagentRegistry();
            mod.activateSubagentRegistry(() => firstGateway as never);
            const oldActiveCount = Math.min(runCount, 2);
            await waitForCalls(oldActiveCount);
            expect(wakeRequester).toHaveBeenCalledTimes(oldActiveCount);
            const oldWork = Promise.all(wakeRequester.mock.results.map((result) => result.value));
            const retiredRuns = runs.map((run) => mod.getSubagentRunByRunId(run.runId)!);
            const retiredResolvers = retiredRuns.map(getGatewayContextResolver);
            const expectedWakes = retiredRuns.map((run) =>
              structuredClone(run.requesterSettleWake),
            );

            // A forced restart retires admission before old async chains return.
            admission.markGatewayRestartDraining();
            firstGatewayOpen = false;
            admission.resetGatewayWorkAdmission();
            if (order === "before-activation") {
              oldDone.resolve(false);
              await oldWork;
              await vi.advanceTimersByTimeAsync(0);
              expect(runs.map((run) => readPersistedRun(run.runId)?.requesterSettleWake)).toEqual(
                expectedWakes,
              );
            }
            mod.activateSubagentRegistry(() => replacementGateway as never);
            const recoveredRuns = runs.map((run) => mod.getSubagentRunByRunId(run.runId)!);
            recoveredRuns.forEach((run, index) => {
              expect(run).not.toBe(retiredRuns[index]);
              expect(retiredResolvers[index]?.()).toBeUndefined();
            });
            for (const params of oldParams) {
              await params.transitionBatch([params.settledEntry], {
                ...params.settledEntry.requesterSettleWake!,
                attemptCount: 99,
              });
            }
            expect(recoveredRuns.map((run) => run.requesterSettleWake)).toEqual(expectedWakes);

            await mod.testing.runSweeperTickForTests();
            await waitForCalls(oldActiveCount * 2);
            expect(wakeRequester).toHaveBeenCalledTimes(oldActiveCount * 2);
            if (order === "replacement-first") {
              replacementDone.resolve();
              await waitForCalls(oldActiveCount + runCount);
              await Promise.all(
                wakeRequester.mock.results.slice(oldActiveCount).map((result) => result.value),
              );
              await vi.advanceTimersByTimeAsync(0);
              expect(recoveredRuns.every((run) => run.requesterSettleWake === undefined)).toBe(
                true,
              );
              expect(oldFinished).toBe(0);
            }
            oldDone.resolve(false);
            await oldWork;
            await vi.advanceTimersByTimeAsync(0);
            await mod.testing.runSweeperTickForTests();
            expect(wakeRequester).toHaveBeenCalledTimes(oldActiveCount + runCount);
            expect(oldParams).toHaveLength(oldActiveCount);
            if (order !== "replacement-first") {
              expect(recoveredRuns.map((run) => run.requesterSettleWake)).toEqual(expectedWakes);
              replacementDone.resolve();
            }
            await waitForCalls(oldActiveCount + runCount);
            await Promise.all(
              wakeRequester.mock.results.slice(oldActiveCount).map((result) => result.value),
            );
            await vi.advanceTimersByTimeAsync(0);
            for (const run of recoveredRuns) {
              expect(readPersistedRun(run.runId)?.requesterSettleWake).toBeUndefined();
              expect(run.delivery?.status).toBe("delivered");
            }
          } finally {
            oldDone.resolve(false);
            replacementDone.resolve();
            await vi.advanceTimersByTimeAsync(0);
          }
        });
      } finally {
        admission.resetGatewayWorkAdmission();
        vi.useRealTimers();
      }
    },
  );

  registerStaleRequesterWakeBatchTests({
    getModules: () => ({ mod, requesterSettleModule, bindGatewayContextResolver }),
    withRegistryState,
    settleOwnedWork: () => settleOwnedWork?.(true),
  });

  it.each([
    { status: "suspended" as const, disposition: undefined, queueId: undefined },
    { status: "in_progress" as const, disposition: "session_queued" as const, queueId: "queue-1" },
  ])("retains $status required delivery with its owner after restart", async (expected) => {
    await withRegistryState(async () => {
      const run = createOrphanedRequiredDelivery(expected.status);
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      mod.initSubagentRegistry();
      activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);
      await nextTask();

      expect(announceSpy).not.toHaveBeenCalled();
      expect(readPersistedRun(run.runId)?.delivery).toMatchObject({
        status: expected.status,
        ...(expected.disposition ? { disposition: expected.disposition } : {}),
        ...(expected.queueId ? { queueId: expected.queueId } : {}),
      });
    });
  });

  it("keeps restored recovery dormant until the Gateway lifecycle activates it", async () => {
    const wakeRequester = vi.fn(async () => false);
    vi.spyOn(requesterSettleModule, "maybeWakeRequesterAfterAllChildrenSettled").mockImplementation(
      wakeRequester,
    );

    await withRegistryState(async (stateDir) => {
      const endedAt = Date.now();
      const yieldedRun = createDeliveredWake("run-hydrated-yield", undefined, {
        taskRunId: "run-hydrated-yield",
        requesterTurnRunId: "run-requester",
        requesterTurnYielded: true,
        childSessionKey: "agent:main:subagent:hydrated-yield",
        task: "wake only after lifecycle activation",
        createdAt: endedAt - 1_000,
        endedReason: "subagent-complete",
        startedAt: endedAt - 500,
        endedAt,
        cleanupCompletedAt: endedAt,
      });
      const queuedCollector = createSubagentRunRecord({
        runId: "run-hydrated-collector",
        childSessionKey: "agent:main:subagent:hydrated-collector",
        task: "clean only after lifecycle activation",
        createdAt: endedAt - 500,
        collect: true,
        swarmRequesterSessionKey: "agent:main:main",
        groupId: "hydrated-group",
        archiveAtMs: endedAt - 1,
        startedAt: endedAt - 400,
        endedAt,
        outcome: { status: "error", error: "launch failed" },
        completion: { required: true },
        delivery: { status: "pending" },
        collectorCompletion: { status: "failed" },
        collectorLaunchCleanupPending: true,
      });
      const runningRun = createSubagentRunRecord({
        runId: "run-hydrated-running",
        childSessionKey: "agent:main:subagent:hydrated-running",
        task: "wait through the activated instance",
        createdAt: endedAt,
        execution: { status: "running", startedAt: endedAt },
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      saveSubagentRegistryToSqlite(
        new Map([
          [yieldedRun.runId, yieldedRun],
          [queuedCollector.runId, queuedCollector],
          [runningRun.runId, runningRun],
        ]),
      );
      await writeChildSession(stateDir, yieldedRun.childSessionKey, "sess-hydrated-yield");
      await writeChildSession(
        stateDir,
        queuedCollector.childSessionKey,
        "sess-hydrated-collector",
        "revision-hydrated-collector",
      );
      await writeChildSession(stateDir, runningRun.childSessionKey, "sess-hydrated-running");

      mod.initSubagentRegistry();
      await nextTask();

      expect(mod.getSubagentRunByRunId(yieldedRun.runId)).toBeDefined();
      expect(mod.getSubagentRunByRunId(queuedCollector.runId)).toBeDefined();
      expect(mod.getSubagentRunByRunId(runningRun.runId)).toBeDefined();
      expect(wakeRequester).not.toHaveBeenCalled();
      expect(callGatewayModule.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.delete" }),
      );

      const recoveryRuntime = {
        ...createSubagentPersistenceRuntime(callGatewayModule.callGateway),
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(async () => ({ status: "pending" })),
      };
      let firstLifecycleOpen = true;
      const gatewayContext = {
        recoveryRuntime,
        resolveGatewayContext: vi.fn(),
      };
      gatewayContext.resolveGatewayContext.mockImplementation(() =>
        firstLifecycleOpen ? (gatewayContext as never) : undefined,
      );
      const resolveGatewayContext = vi.fn(() => gatewayContext as never);
      mod.activateSubagentRegistry(resolveGatewayContext);
      mod.activateSubagentRegistry(resolveGatewayContext);
      const restoredRun = mod.getSubagentRunByRunId(runningRun.runId);
      expect(restoredRun).toBeDefined();
      const restoredGatewayContextResolver = getGatewayContextResolver(restoredRun!);
      expect(restoredGatewayContextResolver).toBeDefined();
      expect(restoredGatewayContextResolver).not.toBe(resolveGatewayContext);
      expect(restoredGatewayContextResolver?.()).toBe(gatewayContext);

      await vi.waitFor(() => {
        expect(wakeRequester).toHaveBeenCalledOnce();
        expect(recoveryRuntime.waitForAgent).toHaveBeenCalledOnce();
      });
      expect(recoveryRuntime.dispatchAgent).not.toHaveBeenCalled();
      expect(callGatewayModule.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "agent.wait" }),
      );

      const sweptWake = createDeferredCore<boolean>();
      wakeRequester.mockImplementationOnce(() => {
        sweptWake.resolve(false);
        return sweptWake.promise;
      });
      await mod.testing.runSweeperTickForTests();
      await sweptWake.promise;
      wakeRequester.mockClear();
      expect(callGatewayModule.callGateway).toHaveBeenCalledTimes(1);
      expect(callGatewayModule.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            expectedSessionId: "sess-hydrated-collector",
            expectedLifecycleRevision: "revision-hydrated-collector",
          }),
        }),
      );

      firstLifecycleOpen = false;
      expect(resolveGatewayContext()).toBe(gatewayContext);
      expect(gatewayContext.resolveGatewayContext()).toBeUndefined();
      expect(restoredGatewayContextResolver?.()).toBeUndefined();
      const replacementRuntime = {
        ...createSubagentPersistenceRuntime(callGatewayModule.callGateway),
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(async () => ({ status: "pending" })),
      };
      const resolveReplacementContext = () =>
        ({ resolveGatewayContext: () => ({ recoveryRuntime: replacementRuntime }) }) as never;
      mod.activateSubagentRegistry(resolveReplacementContext);
      mod.activateSubagentRegistry(resolveReplacementContext);
      expect(getGatewayContextResolver(restoredRun!)).toBe(restoredGatewayContextResolver);
      expect(wakeRequester).not.toHaveBeenCalled();
      expect(recoveryRuntime.waitForAgent).toHaveBeenCalledOnce();
      expect(replacementRuntime.waitForAgent).not.toHaveBeenCalled();

      await mod.testing.runSweeperTickForTests();
      expect(callGatewayModule.callGateway).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    "persisted",
    "activation-created normal",
    "activation-created yielded",
    "caller-wrapped",
  ] as const)(
    "bounds restored %s requester-settle wakes after Gateway activation",
    async (mode) => {
      const activationSettlement = mode.startsWith("activation-created");
      const requesterYielded = mode === "activation-created yielded" ? true : undefined;
      let activeWakes = 0;
      let maxActiveWakes = 0;
      let releaseFutureWakes = false;
      const wakeResolvers: Array<() => void> = [];
      const { run: wakeRequester, waitForCalls } = observeSubagentRequesterWake(async (params) => {
        activeWakes += 1;
        maxActiveWakes = Math.max(maxActiveWakes, activeWakes);
        try {
          if (!releaseFutureWakes) {
            await new Promise<void>((resolve) => {
              wakeResolvers.push(resolve);
            });
          }
          await params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
          );
          return false;
        } finally {
          activeWakes -= 1;
        }
      });
      vi.spyOn(
        requesterSettleModule,
        "maybeWakeRequesterAfterAllChildrenSettled",
      ).mockImplementation(wakeRequester);

      await withRegistryState(async (stateDir) => {
        const endedAt = Date.now();
        const restoredRuns = createRestoredRequesterWakeRuns({
          activationSettlement,
          requesterYielded,
          endedAt,
        });
        saveSubagentRegistryToSqlite(new Map(restoredRuns.map((entry) => [entry.runId, entry])));

        if (activationSettlement) {
          await Promise.all(
            restoredRuns.map((entry, index) =>
              writeChildSession(stateDir, entry.childSessionKey, `sess-restored-wake-${index}`),
            ),
          );
        }

        mod.initSubagentRegistry();
        await nextTask();
        expect(wakeRequester).not.toHaveBeenCalled();

        if (mode === "caller-wrapped") {
          const gateway = { resolveGatewayContext: () => gateway as never };
          for (const run of restoredRuns) {
            bindGatewayContextResolver(
              mod.getSubagentRunByRunId(run.runId)!,
              await withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: run.requesterSessionKey,
                  gatewayContextResolver: gateway.resolveGatewayContext,
                },
                () => getGatewayToolCallerIdentity()?.gatewayContextResolver,
              ),
            );
          }
          mod.activateSubagentRegistry(() => gateway as never);
        } else {
          activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);
        }
        try {
          // Restoration can await task projection and a lazy import before admission.
          await waitForCalls(2);
          expect(wakeRequester).toHaveBeenCalledTimes(2);
          expect(activeWakes).toBe(2);
          expect(maxActiveWakes).toBe(2);

          wakeResolvers.shift()?.();
          await waitForCalls(3);
          expect(wakeRequester).toHaveBeenCalledTimes(3);
          expect(maxActiveWakes).toBe(2);
        } finally {
          // Also release callbacks that have not reached the mock when an assertion fails.
          releaseFutureWakes = true;
          for (const release of wakeResolvers.splice(0)) {
            release();
          }
          await settleSubagentRegistryPersistenceWork(() => settleOwnedWork?.(true));
          expect(activeWakes).toBe(0);
        }
        await mod.testing.runSweeperTickForTests();
        await settleSubagentRegistryPersistenceWork(() => settleOwnedWork?.(true));
        expect(wakeRequester).toHaveBeenCalledTimes(3);
      });
    },
  );

  registerSubagentDismissedRetentionCases({
    getRegistry: () => mod,
    withRegistryState,
    announceSpy,
  });

  it.each([false, true])(
    "settles a restored steered requester turn (yielded: %s)",
    async (requesterYielded) => {
      const wakeRequester = vi.fn(async () => false);
      vi.spyOn(
        requesterSettleModule,
        "maybeWakeRequesterAfterAllChildrenSettled",
      ).mockImplementation(wakeRequester);

      await withRegistryState(async (stateDir) => {
        const endedAt = Date.now();
        const run = createDeliveredWake("run-steered", undefined, {
          taskRunId: "run-original",
          requesterTurnRunId: "run-requester",
          ...(requesterYielded ? { requesterTurnYielded: true } : {}),
          childSessionKey: "agent:main:subagent:steered",
          task: "deliver the steered result",
          createdAt: endedAt - 1_000,
          endedReason: "subagent-complete",
          startedAt: endedAt - 500,
          endedAt,
          cleanupCompletedAt: endedAt,
        });
        const nonannouncing: SubagentRunRecord[] = [];
        for (const collect of [false, true]) {
          nonannouncing.push({
            ...run,
            runId: `run-nonannouncing-${collect}`,
            taskRunId: `run-nonannouncing-${collect}`,
            childSessionKey: `agent:main:subagent:nonannouncing-${collect}`,
            expectsCompletionMessage: false,
            requesterTurnYielded: undefined,
            collect,
            completion: { required: false, resultText: "quiet result", capturedAt: endedAt },
            delivery: { status: "not_required" },
            ...(collect ? { collectorCompletion: { status: "done" } } : {}),
          });
        }
        saveSubagentRegistryToSqlite(
          new Map([run, ...nonannouncing].map((entry) => [entry.runId, entry])),
        );
        for (const entry of [run, ...nonannouncing]) {
          await writeChildSession(stateDir, entry.childSessionKey, `sess-${entry.runId}`);
        }

        mod.initSubagentRegistry();
        activateSubagentPersistenceRegistry(mod, callGatewayModule.callGateway);

        const restored = mod.getSubagentRunByRunId(run.runId);
        expect(restored).toMatchObject({ runId: run.runId, taskRunId: run.taskRunId });
        expect(restored?.requesterTurnRunId).toBeUndefined();
        expect(readPersistedRun(run.runId)?.requesterTurnRunId).toBeUndefined();
        for (const sibling of nonannouncing) {
          expect(mod.getSubagentRunByRunId(sibling.runId)).toMatchObject({
            requesterTurnRunId: "run-requester",
            delivery: { status: "not_required" },
          });
          expect(mod.getSubagentRunByRunId(sibling.runId)?.requesterSettleWake).toBeUndefined();
        }

        if (requesterYielded) {
          expect(restored?.requesterSettleWake).toMatchObject({
            batchRunIds: [run.runId],
            requesterYieldBatch: true,
            afterRequesterYield: true,
          });
          await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledOnce(), {
            timeout: 1_000,
            interval: 10,
          });
        } else {
          expect(restored?.requesterSettleWake).toBeUndefined();
          await nextTask();
          expect(wakeRequester).not.toHaveBeenCalled();
        }
      });
    },
  );
});
