// Restart-path proof against the real registry sweeper and SQLite session store.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import { createRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../command/lifecycle.js";
import { prepareInternalSessionEffectsSession } from "../../internal-session-effects.js";
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
  replaceSubagentRunAfterSteerCore,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import {
  makeRestartRecoveryRun as makeRunRecord,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

describe("subagent orphan recovery — faithful restart path", () => {
  const fixture = useSubagentRestartRecoveryFixture();
  const { acceptRecoveryDispatch, activateGatewayRuntime, dispatchAgent, gatewayRuntime } = fixture;

  it.each([
    ["restart", "lifecycle then wait", "interrupted", undefined],
    ["restart", "wait only", "interrupted", undefined],
    ["restart", "retired wait", "running", undefined],
    ["restart", "retired wait retry", "running", undefined],
    ["aborted", "lifecycle then wait", "terminal", undefined],
    ["restart", "lifecycle then wait", "terminal", "provider"],
    ["restart", "restart then rejected wait", "interrupted", undefined],
    ["restart", "restart then soft timeout", "interrupted", undefined],
    ["error", "restart then provider error", "terminal", undefined],
    ["restart", "restart then provider timeout", "terminal", "provider"],
    ["aborted", "restart then user cancel", "terminal", undefined],
  ] as const)(
    "preserves %s through %s as %s (timeout: %s)",
    async (stopReason, source, expected, timeoutPhase) => {
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
        createdAt: now - runAgeMs,
        startedAt: now - runAgeMs,
        runTimeoutSeconds: 0,
      });
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

  it("continues a steered task through hidden recovery and another cold restart", async () => {
    const childSessionKey = "agent:main:subagent:repeated-restart";
    const sessionId = "repeated-restart-session";
    const runId = "repeated-restart-original";
    const steeredRunId = "repeated-restart-steered";
    const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
      agentId: "main",
    });
    const source = { agentId: "main", storePath, sessionKey: childSessionKey, sessionId };
    await replaceSessionEntry(source, {
      sessionId,
      updatedAt: Date.now(),
      status: "running",
      lifecycleRunId: runId,
      abortedLastRun: true,
    });
    await appendTranscriptMessage(source, {
      message: { role: "user", content: "Complete steps A and B.", timestamp: Date.now() },
    });
    addSubagentRunForTests(makeRunRecord({ runId, childSessionKey }));
    expect(
      replaceSubagentRunAfterSteerCore({ previousRunId: runId, nextRunId: steeredRunId }),
    ).toBe(true);
    await replaceSessionEntry(source, {
      ...loadExactSessionEntry(source)!.entry,
      lifecycleRunId: steeredRunId,
      abortedLastRun: true,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: steeredRunId,
      taskRunId: runId,
    });
    const targets: Awaited<ReturnType<typeof prepareInternalSessionEffectsSession>>[] = [];
    dispatchAgent.mockImplementation(async (payload) => {
      const target = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: String(payload.idempotencyKey),
        source,
        storePath,
      });
      targets.push(target);
      if (targets.length === 1) {
        await appendTranscriptMessage(target, {
          message: {
            role: "assistant",
            content: "Step A committed; receipt UNIQUE_RECOVERY_RECEIPT. Only B remains.",
            timestamp: Date.now(),
          },
        });
      }
      return await acceptRecoveryDispatch(payload);
    });

    await testing.sweepOnceForTests();
    const recovered = getSubagentRunByChildSessionKey(childSessionKey)!;
    expect(recovered.execution.transcriptTarget?.sessionId).toBe(targets[0]?.sessionId);
    const originalTaskRunId = recovered.taskRunId;
    expect(loadExactSessionEntry(source)?.entry).toMatchObject({
      abortedLastRun: false,
      lifecycleRunId: steeredRunId,
      status: "running",
      subagentRecovery: { lastRunId: recovered.runId, sessionLifecycleRunId: steeredRunId },
    });
    resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    initSubagentRegistry();
    activateGatewayRuntime();

    await testing.sweepOnceForTests();

    expect(dispatchAgent).toHaveBeenCalledTimes(2);
    const successor = getSubagentRunByChildSessionKey(childSessionKey)!;
    expect(successor.taskRunId).toBe(originalTaskRunId);
    expect(successor.execution.transcriptTarget?.sessionId).toBe(targets[1]?.sessionId);
    const events = await loadTranscriptEvents(targets[1]!);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          content: "Step A committed; receipt UNIQUE_RECOVERY_RECEIPT. Only B remains.",
        }),
      }),
    );
    expect(JSON.stringify(await loadTranscriptEvents(source))).not.toContain(
      "UNIQUE_RECOVERY_RECEIPT",
    );
  });

  it.each([false, true])(
    "keeps replaced hidden-session cleanup admitted until deletion completes (restart fenced: %s)",
    async (restartFenced) => {
      const childSessionKey = "agent:main:subagent:held-hidden-cleanup";
      const runId = "held-hidden-cleanup-source";
      const nextRunId = "held-hidden-cleanup-successor";
      const sessionId = "held-hidden-cleanup-visible";
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: sessionId,
      });
      const visible = { agentId: "main", storePath, sessionKey: childSessionKey, sessionId };
      const retired = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId,
        source: visible,
        storePath,
      });
      await appendTranscriptMessage(retired, {
        message: {
          role: "assistant",
          content: "Retained recovery progress",
          timestamp: Date.now(),
        },
      });
      const successor = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: nextRunId,
        source: retired,
        storePath,
        requireSource: true,
      });
      addSubagentRunForTests(
        makeRunRecord({
          runId,
          childSessionKey,
          expectsCompletionMessage: false,
          execution: { status: "running", startedAt: Date.now(), transcriptTarget: retired },
        }),
      );
      await settleSubagentRegistryPersistenceWork();
      const parent = tryBeginGatewayRootWorkAdmission("test:replacement");
      if (!parent) {
        throw new Error("expected an admitted replacement parent");
      }
      const entered = createDeferred();
      const released = createDeferred();
      // Hold the real FIFO without leaving a SQLite transaction open.
      const blocker = patchSessionEntryCore(
        visible,
        async () => {
          entered.resolve();
          await released.promise;
          return null;
        },
        { skipMaintenance: true },
      );
      try {
        await entered.promise;
        await parent.run(async () => {
          if (restartFenced) {
            markGatewayRestartDraining();
          }
          expect(
            replaceSubagentRunAfterSteerCore({
              previousRunId: runId,
              nextRunId,
              transcriptTarget: successor,
              restartRecovery: {
                sessionId,
                sessionMarker: `${sessionId}:replacement`,
                idempotencyKey: nextRunId,
                phase: "accepted",
                lifecycleGeneration: getAgentEventLifecycleGeneration(),
              },
            }),
          ).toBe(true);
        });
        parent.release();
        expect(loadExactSessionEntry(retired)?.entry.sessionId).toBe(retired.sessionId);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      } finally {
        parent.release();
        released.resolve();
        try {
          await blocker;
          // Settle the original untracked deletion too when the ownership assertion fails.
          await vi.waitFor(() => expect(loadExactSessionEntry(retired)).toBeUndefined());
          await settleSubagentRegistryPersistenceWork();
        } finally {
          resetGatewayWorkAdmission();
        }
      }
      expect(loadExactSessionEntry(successor)?.entry.sessionId).toBe(successor.sessionId);
      expect(loadExactSessionEntry(visible)?.entry.sessionId).toBe(sessionId);
      expect(await loadTranscriptEvents(successor)).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: "Retained recovery progress" }),
        }),
      );
    },
  );

  it("keeps a newer visible execution untouched after recovery dispatch was accepted", async () => {
    const childSessionKey = "agent:main:subagent:accepted-visible-race";
    const runId = "accepted-visible-source";
    const sessionId = "accepted-visible-session";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      sessionId,
      abortedLastRun: true,
      defaultSessionId: sessionId,
    });
    const source = { agentId: "main", storePath, sessionKey: childSessionKey };
    await replaceSessionEntry(source, {
      sessionId,
      updatedAt: Date.now(),
      lifecycleRunId: runId,
      status: "running",
      abortedLastRun: true,
    });
    addSubagentRunForTests(makeRunRecord({ runId, childSessionKey }));
    dispatchAgent.mockImplementationOnce(async (payload) => {
      const accepted = await acceptRecoveryDispatch(payload);
      await replaceSessionEntry(source, {
        ...loadExactSessionEntry(source)!.entry,
        lifecycleRunId: "newer-visible-run",
        abortedLastRun: false,
        updatedAt: Date.now(),
      });
      return accepted;
    });

    await testing.sweepOnceForTests();
    await testing.sweepOnceForTests();

    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution).toMatchObject({
      status: "terminal",
      suppressSessionEffects: true,
    });
    expect(loadExactSessionEntry(source)?.entry).toMatchObject({
      lifecycleRunId: "newer-visible-run",
      status: "running",
      abortedLastRun: false,
    });
    expect(loadExactSessionEntry(source)?.entry.subagentRecovery).toBeUndefined();
  });

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
    addSubagentRunForTests(
      makeRunRecord({
        runId,
        childSessionKey,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
      }),
    );

    let strictWriteCount = 0;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        strictWriteCount += 1;
        if (strictWriteCount === 3) {
          throw new Error("consumed receipt write failed");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });

    await testing.sweepOnceForTests();

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
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    addSubagentRunForTests(record);

    let strictWriteCount = 0;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        strictWriteCount += 1;
        if (strictWriteCount === 5) {
          throw new Error("successor write failed");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });
    dispatchAgent.mockImplementationOnce(acceptRecoveryDispatch);

    await testing.sweepOnceForTests();

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
    addSubagentRunForTests(
      makeRunRecord({
        runId,
        childSessionKey,
        generation: 1,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
      }),
    );

    let strictWriteCount = 0;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
      onAgentEvent: vi.fn(() => () => undefined),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        strictWriteCount += 1;
        if (strictWriteCount === 4) {
          throw new Error("accepted receipt write failed");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });
    dispatchAgent.mockImplementationOnce(acceptRecoveryDispatch);

    await testing.sweepOnceForTests();

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
      expect(
        createRunningTaskRun({
          runtime: "subagent",
          sourceId: record.runId,
          ownerKey: record.requesterSessionKey,
          scopeKind: "session",
          childSessionKey,
          runId: record.runId,
          task: record.task,
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
