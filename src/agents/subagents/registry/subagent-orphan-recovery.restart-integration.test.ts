import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Restart-path proof against the real registry sweeper and SQLite session store.
import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  makeRestartRecoveryRun as makeRunRecord,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { runStartupSessionMigration } from "../../../gateway/server-startup-session-migration.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  registerAgentRunContext,
  clearAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { acquireGatewayLock } from "../../../infra/gateway-lock.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { createRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../command/lifecycle.js";
import { prepareInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  readSubagentSessionStore,
  removeSubagentSessionEntry,
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

vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

describe("subagent orphan recovery — faithful restart path", () => {
  const fixture = useSubagentRestartRecoveryFixture();
  const { activateGatewayRuntime, dispatchAgent, gatewayRuntime } = fixture;

  it("hands five retained predecessor sessions to restart recovery without startup warnings", async () => {
    const startedAt = Math.floor(performance.timeOrigin) - 60_000;
    const generation = getAgentEventLifecycleGeneration();
    const records = Array.from({ length: 5 }, (_, index) =>
      makeRunRecord({
        runId: `retained-startup-${index}`,
        childSessionKey: `agent:main:subagent:retained-startup-${index}`,
        createdAt: startedAt,
        execution: { status: "running", startedAt, lifecycleGeneration: generation },
        expectsCompletionMessage: true,
      }),
    );
    for (const entry of records) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: entry.childSessionKey },
        {
          sessionId: entry.runId,
          lifecycleRevision: entry.runId,
          lifecycleRunId: entry.runId,
          status: "running",
          startedAt,
          updatedAt: startedAt,
        },
      );
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: entry.runId,
        runId: entry.runId,
        ownerKey: entry.requesterSessionKey,
        scopeKind: "session",
        childSessionKey: entry.childSessionKey,
        task: entry.task,
        deliveryStatus: "pending",
        startedAt,
      });
      addSubagentRunForTests(entry);
    }
    persistSubagentRunsToDiskOrThrow(subagentRuns);
    await fixture.settle();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    const lock = await acquireGatewayLock({
      allowInTests: true,
      port: 24120,
      listenerMode: "foreground",
    });
    if (!lock) {
      throw new Error("expected isolated Gateway ownership");
    }
    const log = { info: vi.fn(), warn: vi.fn() };
    try {
      await lock.run(async () => {
        await runStartupSessionMigration({ cfg: { agents: { entries: { main: {} } } }, log });
        initSubagentRegistry();
        activateGatewayRuntime();
        await testing.sweepOnceForTests();
        await fixture.settle();
        for (const entry of records) {
          expect(findTaskByRunId(entry.runId)).toMatchObject({ status: "failed" });
          expect(
            loadExactSessionEntry({ agentId: "main", sessionKey: entry.childSessionKey })?.entry,
          ).toMatchObject({ status: "failed", endedAt: expect.any(Number) });
          expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.execution).toMatchObject({
            status: "terminal",
            outcome: { status: "error" },
          });
        }
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(log.warn.mock.calls).toEqual([]);
        expect(log.info.mock.calls).toEqual([
          ["session: startup subagents: 0 interrupted, 5 retained by run/task owners"],
        ]);
      });
    } finally {
      await fixture.settle();
      await lock.release();
    }
  });

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
      vi.mocked(onAgentEvent).mockReset();
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
      await fixture.settle();
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
          await registerSubagentRun({
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
        await fixture.settle();

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
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
          runId,
          execution: { status: "terminal", outcome: { status: "error" } },
        });
      } finally {
        if (source === "retired wait retry") {
          vi.useRealTimers();
        }
        oldWait.resolve(waitResult);
        try {
          await fixture.settle();
        } finally {
          if (getActiveGatewayRootWorkCount() === 0) {
            gatewayRuntime.waitForAgent = originalWait;
            resetGatewayWorkAdmission();
          }
        }
      }
    },
  );

  it.each(["run", "admission"] as const)(
    "preserves a fresh %s owner admitted while interrupted completion waits for its terminal lock",
    async (owner) => {
      const runId = "interrupted-commit-race";
      const childSessionKey = "agent:main:subagent:interrupted-commit-race";
      const sessionId = "interrupted-commit-race-session";
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: sessionId,
        abortedLastRun: true,
      });
      const entry = makeRunRecord({ runId, childSessionKey });
      addSubagentRunForTests(entry);
      const entered = createDeferred();
      const release = createDeferred();
      const acquire = vi.spyOn(
        SubagentLifecycleController.prototype,
        "acquireTerminalCompletionLock",
      );
      acquire.mockRestore();
      const lock = vi
        .spyOn(SubagentLifecycleController.prototype, "acquireTerminalCompletionLock")
        .mockImplementation(async function (this: SubagentLifecycleController, targetRunId) {
          const unlock = await acquire.call(this, targetRunId);
          if (targetRunId === runId) {
            entered.resolve();
            await release.promise;
          }
          return unlock;
        });
      const pending = testing.sweepOnceForTests();
      let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      try {
        await entered.promise;
        if (owner === "run") {
          registerAgentRunContext("fresh-execution", { sessionKey: childSessionKey, sessionId });
        } else {
          admission = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [childSessionKey, sessionId],
            assertAllowed: () => {},
          });
        }
        release.resolve();
        await pending;
        expect(entry.execution.endedAt).toBeUndefined();
        expect(entry.execution.outcome).toBeUndefined();
        expect(entry.terminalOwner).toBeUndefined();
        expect(dispatchAgent).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
        lock.mockRestore();
        admission?.release();
        clearAgentRunContext("fresh-execution");
      }
    },
  );

  it.each(["run", "admission", "replaced", "missing", "original"] as const)(
    "delivers a saved interrupted terminal result while preserving the %s child owner",
    async (owner) => {
      const now = Date.now();
      const runId = "saved-terminal-replay";
      const childSessionKey = "agent:main:subagent:saved-terminal-replay";
      const sessionId = "saved-terminal-replay-session";
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: sessionId,
        lifecycleRevision: "saved-terminal-revision",
      });
      await patchSessionEntryCore({ storePath, sessionKey: childSessionKey }, (entry) => ({
        ...entry,
        lifecycleRunId: owner === "run" ? "fresh-execution" : runId,
        status: owner === "run" ? "running" : "failed",
      }));
      if (owner === "missing") {
        await removeSubagentSessionEntry({
          stateDir: fixture.stateDir,
          agentId: "main",
          sessionKey: childSessionKey,
        });
      } else if (owner === "replaced") {
        await replaceSessionEntry(
          { storePath, sessionKey: childSessionKey },
          {
            sessionId: "replacement-session",
            lifecycleRevision: "replacement-revision",
            lifecycleRunId: "replacement-run",
            status: "running",
            updatedAt: now,
          },
        );
      }
      const entry = makeRunRecord({
        runId,
        childSessionKey,
        expectsCompletionMessage: true,
        endedReason: "subagent-error",
        terminalOwner: "interrupted-recovery",
        execution: {
          status: "terminal",
          endedAt: now,
          outcome: { status: "error", error: "Saved restart outcome" },
        },
        completion: { required: true, resultText: null, capturedAt: now },
      });
      addSubagentRunForTests(entry);
      const announce = vi.mocked(runSubagentAnnounceFlow);
      const cleanupBrowser = vi.mocked(cleanupBrowserSessionsForLifecycleEnd);
      let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      try {
        if (owner === "run") {
          registerAgentRunContext("fresh-execution", { sessionKey: childSessionKey, sessionId });
        } else if (owner === "admission") {
          admission = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [childSessionKey, sessionId],
            assertAllowed: () => {},
          });
        }
        const before = loadExactSessionEntry({ storePath, sessionKey: childSessionKey })?.entry;
        await testing.sweepOnceForTests();
        await vi.waitFor(() =>
          expect(announce).toHaveBeenCalledWith(
            expect.objectContaining({
              childRunId: runId,
              outcome: expect.objectContaining({ status: "error", error: "Saved restart outcome" }),
              suppressChildSessionEffects: owner !== "original",
            }),
          ),
        );
        expect(cleanupBrowser).toHaveBeenCalledTimes(owner === "original" ? 1 : 0);
        if (owner !== "original") {
          expect(loadExactSessionEntry({ storePath, sessionKey: childSessionKey })?.entry).toEqual(
            before,
          );
        }
      } finally {
        admission?.release();
        clearAgentRunContext("fresh-execution");
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
      error: expect.stringContaining("Gateway restart"),
    });

    await fixture.settle();
    resetTaskRegistryForTests({ persist: false });
    expect(findTaskByRunId(runId)).toMatchObject({ status: "failed" });
    await cleanupSessionStateForTest();
    const persistedSession = (await readSubagentSessionStore(storePath))[childSessionKey];
    expect(persistedSession).toMatchObject({
      status: "failed",
      endedAt: expect.any(Number),
    });
    expect(persistedSession?.abortedLastRun).toBeUndefined();
    expect(
      (
        await loadTranscriptEvents({
          agentId: "main",
          storePath,
          sessionKey: childSessionKey,
          sessionId: "sess-stale-aborted",
        })
      ).filter((event) => isRecord(event) && event.customType === "run-failed-before-reply"),
    ).toMatchObject([
      {
        display: true,
        details: { runId, error: expect.stringContaining("Gateway restart") },
      },
    ]);
  });

  it.each([60_000, 3 * TWO_HOURS_MS])(
    "settles an interrupted run that started %i ms ago without replay",
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

      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        runId,
        execution: { status: "terminal", outcome: { status: "error" } },
      });
    },
  );

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
      await fixture.settle();
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
          await fixture.settle();
        } finally {
          if (getActiveGatewayRootWorkCount() === 0) {
            resetGatewayWorkAdmission();
          }
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

    await fixture.settle();
    resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
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
          error: expect.stringContaining("Gateway restart"),
        },
      },
    });
    await fixture.settle();
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
    await fixture.settle();
    expect(restoredAgain?.execution.restartRecovery).toBeUndefined();
    expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
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
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(runs.some((entry) => entry.runId === staleRecord.runId)).toBe(false);
    expect(runs).toContainEqual(
      expect.objectContaining({
        runId: freshRecord.runId,
        execution: expect.objectContaining({ status: "terminal" }),
      }),
    );
    expect(findTaskByRunId(staleRecord.runId)).toMatchObject({ status: "failed" });
    expect(findTaskByRunId(freshRecord.runId)).toMatchObject({ status: "failed" });
  });
});
