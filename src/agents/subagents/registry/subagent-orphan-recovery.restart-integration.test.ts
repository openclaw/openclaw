// Restart-path proof against the real registry sweeper and SQLite session store.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { createRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../command/lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  createSubagentRegistryTestDeps,
  readSubagentSessionStore,
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import {
  createCoreRequiredTaskBacking,
  makeRestartRecoveryRun as makeRunRecord,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

const subagentRegistryWarn = vi.hoisted(() => vi.fn());

vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));
vi.mock("../../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "agents/subagent-registry"
        ? { ...logger, warn: subagentRegistryWarn }
        : logger;
    },
  };
});

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

describe("subagent orphan recovery — faithful restart path", () => {
  const fixture = useSubagentRestartRecoveryFixture();
  const { acceptRecoveryDispatch, activateGatewayRuntime, dispatchAgent, gatewayRuntime } = fixture;

  it.each([
    {
      source: "lifecycle then wait",
      stopReason: "restart",
      timeoutPhase: undefined,
      expected: "interrupted",
    },
    {
      source: "wait only",
      stopReason: "restart",
      timeoutPhase: undefined,
      expected: "interrupted",
    },
    { source: "retired wait", stopReason: "restart", timeoutPhase: undefined, expected: "running" },
    {
      source: "retired wait retry",
      stopReason: "restart",
      timeoutPhase: undefined,
      expected: "running",
    },
    {
      source: "lifecycle then wait",
      stopReason: "aborted",
      timeoutPhase: undefined,
      expected: "terminal",
    },
    {
      source: "lifecycle then wait",
      stopReason: "restart",
      timeoutPhase: "provider",
      expected: "terminal",
    },
    {
      source: "restart then rejected wait",
      stopReason: "restart",
      timeoutPhase: undefined,
      expected: "interrupted",
    },
    {
      source: "restart then soft timeout",
      stopReason: "restart",
      timeoutPhase: undefined,
      expected: "interrupted",
    },
    {
      source: "restart then provider error",
      stopReason: "error",
      timeoutPhase: undefined,
      expected: "terminal",
    },
    {
      source: "restart then provider timeout",
      stopReason: "restart",
      timeoutPhase: "provider",
      expected: "terminal",
    },
    {
      source: "restart then user cancel",
      stopReason: "aborted",
      timeoutPhase: undefined,
      expected: "terminal",
    },
  ] as const)(
    "preserves $stopReason through $source as $expected (timeout: $timeoutPhase)",
    async ({ source, stopReason, expected, timeoutPhase }) => {
      const runId = "live-restart-child";
      const childSessionKey = "agent:main:subagent:live-restart-child";
      const startedAt = Date.now();
      const waitRequests: string[] = [];
      const waitResult = {
        status: "error" as const,
        stopReason,
        timeoutPhase,
        error: stopReason === "error" ? "provider terminal failure" : undefined,
        startedAt,
        endedAt: startedAt + 1,
      };
      const oldWait = createDeferred<typeof waitResult>();
      testing.setDepsForTest({
        ...createSubagentRegistryTestDeps(),
        onAgentEvent,
        runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      });
      const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: "main",
      });
      await replaceSessionEntry(
        { storePath, sessionKey: childSessionKey },
        {
          sessionId: "live-restart-child-session",
          updatedAt: startedAt,
          startedAt,
          lifecycleRunId: runId,
          status: "running",
        },
      );
      resetGatewayWorkAdmission();
      const originalWait = gatewayRuntime.waitForAgent;
      gatewayRuntime.waitForAgent = async <T>(
        params: Parameters<GatewayRecoveryRuntime["waitForAgent"]>[0],
      ): Promise<T> => {
        waitRequests.push(params.runId);
        return (params.runId === runId ? await oldWait.promise : { status: "pending" }) as T;
      };
      try {
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          registerSubagentRun({
            runId,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "continue after update",
            cleanup: "keep",
            expectsCompletionMessage: false,
            taskRowOwnership: "required",
          });
          await vi.waitFor(() => expect(waitRequests).toContain(runId));
          markGatewayRestartDraining();
          const restartsBeforeWait = source.startsWith("restart then ");
          if (source === "lifecycle then wait" || restartsBeforeWait) {
            createAgentCommandLifecycle({
              runId,
              startedAt,
              lifecycleGeneration: getAgentEventLifecycleGeneration,
              state: {
                currentTurnUserMessagePersisted: true,
                lifecycleEnded: false,
                lifecycleFinishing: false,
              },
            }).emitEnd({
              outcome: buildAgentRunTerminalOutcome(
                restartsBeforeWait
                  ? { status: "error", stopReason: "restart", startedAt }
                  : waitResult,
              ),
              metadata: { aborted: true },
            });
            await vi.dynamicImportSettled();
            if (restartsBeforeWait) {
              expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.status).toBe(
                "interrupted",
              );
            } else if (expected === "interrupted") {
              await vi.waitFor(() =>
                expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.status).not.toBe(
                  "running",
                ),
              );
            }
          } else if (source === "retired wait") {
            rotateAgentEventLifecycleGeneration();
          }
          if (source === "retired wait retry") {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            oldWait.reject(new Error("gateway request timeout"));
            await vi.advanceTimersByTimeAsync(0);
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            rotateAgentEventLifecycleGeneration();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(waitRequests.filter((id) => id === runId)).toHaveLength(1);
            vi.useRealTimers();
          } else if (source === "restart then rejected wait") {
            oldWait.reject(
              new Error(
                "gateway rejected websocket upgrade (HTTP503): Gateway websocket admission closed",
              ),
            );
          } else if (source === "restart then soft timeout") {
            oldWait.reject(new Error("gateway request timeout"));
          } else {
            oldWait.resolve(waitResult);
          }
          await vi.dynamicImportSettled();
        }, "test:admitted-agent");
        await settleSubagentRegistryPersistenceWork();

        const persisted = loadSubagentRegistryFromSqlite().get(runId);
        expect(persisted?.execution.status).toBe(expected);
        if (expected === "terminal") {
          expect(persisted?.execution.outcome?.status).toBe(timeoutPhase ? "timeout" : "error");
          expect(persisted?.execution.interruptionReason).toBeUndefined();
          expect(findTaskByRunId(runId)?.status).toBe(
            timeoutPhase ? "timed_out" : stopReason === "error" ? "failed" : "cancelled",
          );
          return;
        }
        if (expected === "interrupted") {
          expect(persisted?.execution.interruptionReason).toBe("gateway-restart");
        }
        expect(persisted?.execution.endedAt).toBeUndefined();
        expect(findTaskByRunId(runId)?.status).toBe("running");

        resetSubagentRegistryForTests({ persist: false });
        resetGatewayWorkAdmission();
        rotateAgentEventLifecycleGeneration();
        initSubagentRegistry();
        activateGatewayRuntime();
        await testing.sweepOnceForTests();
        expect(dispatchAgent).toHaveBeenCalledOnce();
        expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe(
          String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey),
        );
      } finally {
        if (source === "retired wait retry") {
          vi.useRealTimers();
        }
        oldWait.resolve(waitResult);
        gatewayRuntime.waitForAgent = originalWait;
        resetGatewayWorkAdmission();
      }
    },
  );

  it("finalizes a run interrupted more than two hours ago instead of resuming it", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-aborted";
    const runId = "run-stale-aborted";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-stale-aborted",
      updatedAt: now - 3 * TWO_HOURS_MS,
      abortedLastRun: true,
      defaultSessionId: "sess-stale-aborted",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      generation: 1,
      createdAt: now - 3 * TWO_HOURS_MS,
      startedAt: now - 3 * TWO_HOURS_MS,
    });
    expect(
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: record.requesterSessionKey,
        scopeKind: "session",
        childSessionKey,
        runId,
        task: record.task,
        detail: createSubagentTaskBackingDetail(1),
        deliveryStatus: "pending",
        startedAt: record.execution.startedAt,
        lastEventAt: record.execution.startedAt,
      }),
    ).not.toBeNull();
    addSubagentRunForTests(record);

    await testing.sweepOnceForTests();

    const after = getSubagentRunByChildSessionKey(childSessionKey);
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(after?.execution.endedAt).toBeTypeOf("number");
    expect(after?.execution.outcome?.status).toBe("error");
    expect(findTaskByRunId(runId)).toMatchObject({
      status: "failed",
      endedAt: expect.any(Number),
      error: expect.stringContaining("stale aborted subagent run not resumed"),
    });

    resetTaskRegistryForTests({ persist: false });
    expect(findTaskByRunId(runId)).toMatchObject({ status: "failed" });
    await cleanupSessionStateForTest();
    const persistedSession = (await readSubagentSessionStore(storePath))[childSessionKey];
    expect(persistedSession).toMatchObject({
      status: "failed",
      endedAt: expect.any(Number),
    });
    expect(persistedSession?.abortedLastRun).toBeUndefined();
  });

  it.each([60_000, 3 * TWO_HOURS_MS])(
    "resumes a recently interrupted run that started %i ms ago",
    async (runAgeMs) => {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:fresh-aborted";
      const runId = "run-fresh-aborted";
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        sessionId: "sess-fresh-aborted",
        updatedAt: now,
        abortedLastRun: true,
        defaultSessionId: "sess-fresh-aborted",
      });
      const record = makeRunRecord({
        runId,
        childSessionKey,
        taskOwnershipPolicy: "core_required",
        generation: 1,
        createdAt: now - runAgeMs,
        startedAt: now - runAgeMs,
        runTimeoutSeconds: 0,
      });
      createCoreRequiredTaskBacking(record);
      addSubagentRunForTests(record);

      await testing.sweepOnceForTests();

      // Recent interruption, rather than total runtime, owns recovery eligibility.
      expect(dispatchAgent).toHaveBeenCalledOnce();
      expect(dispatchAgent.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: childSessionKey,
        lane: "subagent",
        deliver: false,
      });
      expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe(
        String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey),
      );
    },
  );

  it("recovers gateway-best-effort ownership without creating a CLI task across two cold restores", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:gateway-best-effort-recovery";
    const runId = "run-gateway-best-effort-recovery";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-gateway-best-effort-recovery",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-gateway-best-effort-recovery",
    });
    addSubagentRunForTests(
      makeRunRecord({
        runId,
        childSessionKey,
        taskOwnershipPolicy: "gateway_best_effort",
        createdAt: now - 60_000,
        startedAt: now - 55_000,
      }),
    );
    expect(findTaskByRunId(runId)).toBeUndefined();

    await testing.sweepOnceForTests();

    expect(dispatchAgent).toHaveBeenCalledOnce();
    const acceptedKey = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: acceptedKey,
      taskOwnershipPolicy: "gateway_best_effort",
      execution: { status: "running" },
    });
    expect(
      getSubagentRunByChildSessionKey(childSessionKey)?.execution.restartRecovery,
    ).toBeUndefined();
    expect(findTaskByRunId(runId)).toBeUndefined();
    expect(findTaskByRunId(acceptedKey)).toBeUndefined();

    for (let restore = 0; restore < 2; restore += 1) {
      resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryForTests({ persist: false });
      rotateAgentEventLifecycleGeneration();
      initSubagentRegistry();
      activateGatewayRuntime();
      await testing.sweepOnceForTests();
      expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        runId: acceptedKey,
        taskOwnershipPolicy: "gateway_best_effort",
        execution: { status: "running" },
      });
      expect(
        getSubagentRunByChildSessionKey(childSessionKey)?.execution.restartRecovery,
      ).toBeUndefined();
      expect(findTaskByRunId(runId)).toBeUndefined();
      expect(findTaskByRunId(acceptedKey)).toBeUndefined();
    }
    expect(dispatchAgent).toHaveBeenCalledOnce();
  });

  it("keeps an unresolved released row deferred and unchanged across cold restores", async () => {
    const now = Date.now();
    const runId = "run-released-unmarked";
    const childSessionKey = "agent:main:subagent:released-unmarked";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-released-unmarked",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-released-unmarked",
    });
    const releasedRecord = makeRunRecord({
      runId,
      childSessionKey,
      requesterAgentId: "main",
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    releasedRecord.taskOwnershipPolicy = "legacy_unresolved";
    delete releasedRecord.taskTerminalProjection;
    addSubagentRunForTests(releasedRecord);
    persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);
    const readPersistedPayload = () =>
      (
        openOpenClawStateDatabase()
          .db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
          .get(runId) as { payload_json: string }
      ).payload_json;
    const releasedPayload = readPersistedPayload();
    const releasedSession = (await readSubagentSessionStore(storePath))[childSessionKey];
    subagentRegistryWarn.mockClear();
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
    });

    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
    rotateAgentEventLifecycleGeneration();
    initSubagentRegistry();
    activateGatewayRuntime();
    await testing.sweepOnceForTests();
    await testing.sweepOnceForTests();

    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(findTaskByRunId(runId)).toBeUndefined();
    expect(subagentRegistryWarn).toHaveBeenCalledExactlyOnceWith(
      "subagent restart recovery is waiting for authoritative task ownership",
      expect.objectContaining({
        reason: "has unresolved legacy task ownership",
        action: "inspect the subagent and task records before retrying the subagent request",
      }),
    );
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.taskOwnershipPolicy).toBe(
      "legacy_unresolved",
    );
    expect(readPersistedPayload()).toBe(releasedPayload);
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toEqual(releasedSession);

    resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
    rotateAgentEventLifecycleGeneration();
    initSubagentRegistry();
    activateGatewayRuntime();

    expect(getSubagentRunByChildSessionKey(childSessionKey)?.taskOwnershipPolicy).toBe(
      "legacy_unresolved",
    );
    expect(readPersistedPayload()).toBe(releasedPayload);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it.each(["missing", "mismatched"] as const)(
    "rejects core-required recovery when its canonical backing is %s",
    async (backingState) => {
      const now = Date.now();
      const childSessionKey = `agent:main:subagent:core-${backingState}-backing`;
      const runId = `run-core-${backingState}-backing`;
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        sessionId: `sess-core-${backingState}-backing`,
        updatedAt: now,
        abortedLastRun: true,
        defaultSessionId: `sess-core-${backingState}-backing`,
      });
      const record = makeRunRecord({
        runId,
        childSessionKey,
        taskOwnershipPolicy: "core_required",
        generation: 1,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
      });
      if (backingState === "mismatched") {
        createRunningTaskRun({
          runtime: "subagent",
          sourceId: runId,
          ownerKey: record.requesterSessionKey,
          scopeKind: "session",
          childSessionKey,
          runId,
          task: record.task,
          detail: createSubagentTaskBackingDetail(2),
          deliveryStatus: "pending",
          startedAt: record.execution.startedAt,
          lastEventAt: record.execution.startedAt,
        });
      }
      addSubagentRunForTests(record);
      persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);

      await testing.sweepOnceForTests();

      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(getSubagentRunByChildSessionKey(childSessionKey)).toBe(record);
      expect(record.execution.restartRecovery).toBeUndefined();
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        runId,
        taskOwnershipPolicy: "core_required",
        execution: { status: "running" },
      });
      expect(
        loadSubagentRegistryFromSqlite().get(runId)?.execution.restartRecovery,
      ).toBeUndefined();
    },
  );

  it("preserves an accepted response across a consumed-receipt write failure", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:consumed-write-failure";
    const runId = "run-consumed-write-failure";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-consumed-write-failure",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-consumed-write-failure",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      taskOwnershipPolicy: "core_required",
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    createCoreRequiredTaskBacking(record);
    addSubagentRunForTests(record);
    const database = openOpenClawStateDatabase().db;
    database.exec(`CREATE TEMP TRIGGER reject_consumed_recovery_receipt
      BEFORE UPDATE ON subagent_runs
      WHEN NEW.run_id = 'run-consumed-write-failure'
        AND json_extract(NEW.payload_json, '$.execution.restartRecovery.phase') = 'consumed'
      BEGIN SELECT RAISE(ABORT, 'consumed receipt write failed'); END`);

    try {
      await testing.sweepOnceForTests();
    } finally {
      database.exec("DROP TRIGGER reject_consumed_recovery_receipt");
    }

    expect(dispatchAgent).toHaveBeenCalledOnce();
    const acceptedKey = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    const successor = getSubagentRunByChildSessionKey(childSessionKey);
    expect(successor?.runId).toBe(acceptedKey);
    expect(successor?.execution.restartRecovery).toBeUndefined();
    expect(
      loadSubagentRegistryFromSqlite().get(acceptedKey)?.execution.restartRecovery,
    ).toBeUndefined();
  });

  it("never replays an attempted recovery after acceptance response loss and cold restore", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:lost-acceptance";
    const runId = "run-lost-acceptance";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-lost-acceptance",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-lost-acceptance",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      generation: 1,
      collect: true,
      outputSchema: { type: "object" },
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    addSubagentRunForTests(record);

    let acceptedKey = "";
    let acceptedAdmission: SessionWorkAdmissionLease | undefined;
    dispatchAgent.mockImplementationOnce(async (payload) => {
      acceptedKey = String(payload.idempotencyKey);
      acceptedAdmission = consumeSessionWorkAdmissionHandoff({
        handoffId: String(payload.internalRuntimeHandoffId),
        scope: storePath,
        identities: [childSessionKey, "sess-lost-acceptance"],
        onInterrupt: () => undefined,
      });
      expect(acceptedAdmission).toBeDefined();
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        execution: {
          restartRecovery: {
            sessionId: "sess-lost-acceptance",
            sessionMarker: `sess-lost-acceptance:${now}`,
            idempotencyKey: acceptedKey,
            phase: "attempted",
          },
        },
        swarmLaunchIdempotencyKey: acceptedKey,
        swarmLaunchPending: true,
      });
      throw new Error("response lost after gateway acceptance");
    });

    await testing.sweepOnceForTests();

    expect(acceptedKey).toMatch(/^subagent-recovery:[a-f0-9]{64}$/);
    let admissionReleased = false;
    void acceptedAdmission?.released.then(() => {
      admissionReleased = true;
    });
    await Promise.resolve();
    expect(admissionReleased).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      execution: {
        restartRecovery: {
          sessionId: "sess-lost-acceptance",
          sessionMarker: `sess-lost-acceptance:${now}`,
          idempotencyKey: acceptedKey,
          phase: "consumed",
        },
      },
    });

    resetSubagentRegistryForTests({ persist: false });
    acceptedAdmission?.release();
    rotateAgentEventLifecycleGeneration();
    initSubagentRegistry();
    activateGatewayRuntime();
    const restored = subagentRuns.get(runId);
    expect(restored?.execution.restartRecovery).toMatchObject({
      sessionMarker: `sess-lost-acceptance:${now}`,
      idempotencyKey: acceptedKey,
      phase: "consumed",
    });

    await testing.sweepOnceForTests();

    const dispatchedKeys = dispatchAgent.mock.calls.map(([payload]) =>
      String(payload.idempotencyKey),
    );
    expect(dispatchedKeys).toEqual([acceptedKey]);
    expect(subagentRuns.get(runId)).toMatchObject({
      execution: {
        status: "terminal",
        outcome: {
          status: "error",
          error: expect.stringContaining("retired Gateway lifecycle"),
        },
        restartRecovery: undefined,
        suppressSessionEffects: true,
      },
    });
    const preservedSession = (await readSubagentSessionStore(storePath))[childSessionKey];
    expect(preservedSession).toMatchObject({ abortedLastRun: true });
    expect(preservedSession?.status).toBeUndefined();
  });

  it("settles the accepted source before durable remap and clears the successor receipt", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:successor-write-failure";
    const runId = "run-successor-write-failure";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-successor-write-failure",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-successor-write-failure",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      taskOwnershipPolicy: "core_required",
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    createCoreRequiredTaskBacking(record);
    addSubagentRunForTests(record);

    dispatchAgent.mockImplementationOnce(acceptRecoveryDispatch);
    const database = openOpenClawStateDatabase().db;
    database.exec(`CREATE TEMP TRIGGER reject_recovery_successor
      BEFORE INSERT ON subagent_runs
      WHEN NEW.run_id LIKE 'subagent-recovery:%'
      BEGIN SELECT RAISE(ABORT, 'successor write failed'); END`);

    try {
      await testing.sweepOnceForTests();
    } finally {
      database.exec("DROP TRIGGER reject_recovery_successor");
    }

    const acceptedKey = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    expect(subagentRuns.get(runId)).toMatchObject({
      execution: {
        restartRecovery: {
          idempotencyKey: acceptedKey,
          phase: "accepted",
        },
      },
    });
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      execution: {
        restartRecovery: {
          idempotencyKey: acceptedKey,
          phase: "accepted",
        },
      },
    });
    expect(subagentRuns.has(acceptedKey)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().has(acceptedKey)).toBe(false);
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });

    resetSubagentRegistryForTests({ persist: false });
    const callGatewayRequests = vi.fn(async (_request: CallGatewayOptions) => ({
      status: "pending",
    }));
    const callGateway = async <T = Record<string, unknown>>(
      request: CallGatewayOptions,
    ): Promise<T> => (await callGatewayRequests(request)) as unknown as T;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      callGateway,
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
    });
    initSubagentRegistry();
    activateGatewayRuntime();
    await Promise.resolve();
    expect(
      callGatewayRequests.mock.calls.some(
        ([request]) =>
          request.method === "agent.wait" &&
          (request.params as { runId?: unknown } | undefined)?.runId === runId,
      ),
    ).toBe(false);
    expect(subagentRuns.get(runId)?.execution.restartRecovery).toMatchObject({
      idempotencyKey: acceptedKey,
      phase: "accepted",
    });
    await testing.sweepOnceForTests();

    expect(dispatchAgent.mock.calls.map(([payload]) => String(payload.idempotencyKey))).toEqual([
      acceptedKey,
    ]);
    const successor = getSubagentRunByChildSessionKey(childSessionKey);
    expect(successor?.runId).toBe(acceptedKey);
    expect(successor?.execution.restartRecovery).toBeUndefined();
    expect(
      loadSubagentRegistryFromSqlite().get(acceptedKey)?.execution.restartRecovery,
    ).toBeUndefined();
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: false,
    });
  });

  it("preserves a newer restart marker when cold-restoring a retired accepted receipt", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:retired-accepted";
    const runId = "run-retired-accepted";
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-retired-accepted",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-retired-accepted",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      execution: {
        status: "interrupted",
        startedAt: now - 55_000,
        restartRecovery: {
          sessionId: "sess-retired-accepted",
          sessionMarker: "sess-retired-accepted:1",
          idempotencyKey: "subagent-recovery:retired-accepted",
          phase: "accepted",
          lifecycleGeneration: priorLifecycleGeneration,
        },
      },
    });
    addSubagentRunForTests(record);
    persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);

    resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
    });
    initSubagentRegistry();
    activateGatewayRuntime();
    await Promise.resolve();
    await testing.sweepOnceForTests();

    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(subagentRuns.get(runId)).toMatchObject({
      execution: {
        status: "terminal",
        outcome: {
          status: "error",
          error: expect.stringContaining("retired Gateway lifecycle"),
        },
      },
    });
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
    const persisted = loadSubagentRegistryFromSqlite().get(runId);
    expect(persisted).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
      },
    });
    expect(persisted?.execution.restartRecovery).toBeUndefined();

    resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    initSubagentRegistry();
    activateGatewayRuntime();
    await Promise.resolve();
    await testing.sweepOnceForTests();

    const restoredAgain = subagentRuns.get(runId);
    expect(restoredAgain).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
      },
    });
    expect(restoredAgain?.execution.restartRecovery).toBeUndefined();
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
  });

  it("strict-remaps immediately when the accepted receipt write fails", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:accepted-write-failure";
    const runId = "run-accepted-write-failure";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-accepted-write-failure",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-accepted-write-failure",
    });
    const record = makeRunRecord({
      runId,
      childSessionKey,
      taskOwnershipPolicy: "core_required",
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    createCoreRequiredTaskBacking(record);
    addSubagentRunForTests(record);
    dispatchAgent.mockImplementationOnce(acceptRecoveryDispatch);
    const database = openOpenClawStateDatabase().db;
    database.exec(`CREATE TEMP TRIGGER reject_accepted_recovery_receipt
      BEFORE UPDATE ON subagent_runs
      WHEN NEW.run_id = 'run-accepted-write-failure'
        AND json_extract(NEW.payload_json, '$.execution.restartRecovery.phase') = 'accepted'
      BEGIN SELECT RAISE(ABORT, 'accepted receipt write failed'); END`);

    try {
      await testing.sweepOnceForTests();
    } finally {
      database.exec("DROP TRIGGER reject_accepted_recovery_receipt");
    }

    const acceptedKey = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    expect(subagentRuns.has(runId)).toBe(false);
    expect(subagentRuns.get(acceptedKey)).toMatchObject({
      runId: acceptedKey,
      execution: { status: "running", restartRecovery: undefined },
    });
    expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
    const persistedSuccessor = loadSubagentRegistryFromSqlite().get(acceptedKey);
    expect(persistedSuccessor).toMatchObject({
      runId: acceptedKey,
      execution: { status: "running" },
    });
    expect(persistedSuccessor?.execution.restartRecovery).toBeUndefined();
  });

  it("finalizes only a stale predecessor when a fresh generation shares its child session", async () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-generation";
    const staleRecord = makeRunRecord({
      runId: "run-stale-generation",
      childSessionKey,
      generation: 1,
      createdAt: now - 3 * 60 * 60 * 1_000,
      startedAt: now - 3 * 60 * 60 * 1_000,
      sessionStartedAt: now - 3 * 60 * 60 * 1_000,
    });
    const freshRecord = makeRunRecord({
      runId: "run-fresh-generation",
      childSessionKey,
      generation: 2,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      sessionStartedAt: now - 60_000,
    });
    for (const record of [staleRecord, freshRecord]) {
      if (record.generation === undefined) {
        throw new Error("Restart fixture did not define a task backing generation");
      }
      expect(
        createRunningTaskRun({
          runtime: "subagent",
          sourceId: record.runId,
          ownerKey: record.requesterSessionKey,
          scopeKind: "session",
          childSessionKey,
          runId: record.runId,
          task: record.task,
          detail: createSubagentTaskBackingDetail(record.generation),
          deliveryStatus: "pending",
          startedAt: record.execution.startedAt,
          lastEventAt: record.execution.startedAt,
        }),
      ).not.toBeNull();
    }
    addSubagentRunForTests(staleRecord);
    addSubagentRunForTests(freshRecord);

    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId: "sess-shared-generation",
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: "sess-shared-generation",
    });
    await testing.sweepOnceForTests();

    const runs = listSubagentRunsForRequester("agent:main:main");
    const recoveredRunId = String(dispatchAgent.mock.calls[0]?.[0].idempotencyKey);
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(runs.some((entry) => entry.runId === staleRecord.runId)).toBe(false);
    expect(runs).toContainEqual(expect.objectContaining({ runId: recoveredRunId }));
    expect(runs.find((entry) => entry.runId === recoveredRunId)?.execution.endedAt).toBeUndefined();
    expect(findTaskByRunId(staleRecord.runId)).toMatchObject({ status: "failed" });
    expect(findTaskByRunId(freshRecord.runId)).toMatchObject({ status: "running" });
  });
});
