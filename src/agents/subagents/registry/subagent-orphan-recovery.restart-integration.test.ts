import { existsSync } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Restart-path proof against the real registry sweeper and SQLite session store.
import { describe, expect, it, onTestFinished, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { makeRestartRecoveryRun as makeRunRecord, useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { runStartupSessionMaintenanceForTest } from "../../../gateway/server-startup-session-migration.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { acquireGatewayLock } from "../../../infra/gateway-lock.js";
import * as gatewayWorkAdmission from "../../../process/gateway-work-admission.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { beginSessionEffect } from "../../../sessions/session-controller.lifecycle.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../command/lifecycle.js";
import { prepareInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { registerRecoveredTerminalTailTest } from "./subagent-orphan-recovery.live-tail.test-support.js";
import {
  createRecoverySessions,
  rawChildFixture,
  readSession,
  restartRegistry,
} from "./subagent-orphan-recovery.raw-owner.test-support.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  prepareSubagentRecoveryFixture,
  readSubagentSessionStore,
  removeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey as readChildRun,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const readPersisted = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);

it.each(["durable", "incognito"] as const)(
  "classifies missing %s storage for recovery without creating its database",
  async (storage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const databasePath = (
        storage === "incognito"
          ? resolveIncognitoOpenClawAgentSqlitePath
          : resolveOpenClawAgentSqlitePath
      )({ agentId: "main", env: state.env });
      if (storage === "incognito") {
        onTestFinished(() =>
          memorySessionActorOwners.closeDatabase({ agentId: "main", path: databasePath }),
        );
      }
      const childSessionKey = `agent:main:subagent:${storage === "incognito" ? "incognito-" : ""}missing-store`;
      const entry = makeRunRecord({
        runId: "missing-store-run",
        childSessionKey,
        childSessionIdentity: { sessionId: "lost-session", lifecycleRevision: "lost-revision" },
        execution: { status: "interrupted", startedAt: Date.now() - 1_000 },
      });
      const warn = vi.fn();
      const recover = (candidate: SubagentRunRecord) =>
        recoverInterruptedSubagentRow({
          entry: candidate,
          runId: candidate.runId,
          gatewayRuntime: undefined,
          isCurrent: () => true,
          warn,
        });
      const expectAbsent = () => {
        expect(existsSync(databasePath)).toBe(false);
        expect(
          memorySessionActorOwners.read({ agentId: "main", path: databasePath }),
        ).toBeUndefined();
      };
      expectAbsent();
      const running = { ...entry, execution: { ...entry.execution, status: "running" as const } };
      expect(await recover(running)).toEqual({ status: "ignored" });
      // An absent incognito actor must not fall back to SQLite, including authority preparation.
      const sql = storage === "incognito" ? observeMainThreadSql() : undefined;
      onTestFinished(() => sql?.restore());
      const result = await recover(entry);
      expect(result).toMatchObject({ status: "terminal", suppressSessionEffects: true });
      if (result.status !== "terminal") {
        throw new Error("Expected missing child storage to permit terminal settlement");
      }
      expect(await result.recoveryCurrent?.prepare()).toBe(true);
      expect(result.recoveryCurrent?.isHostCurrent()).toBe(true);
      if (sql) {
        expect(await result.sessionEffects?.isCurrent()).toBe(true);
        sql.expectIdle();
        sql.restore();
      }
      expect(warn).not.toHaveBeenCalled();
      expect(
        await recover({
          ...running,
          execution: {
            ...running.execution,
            restartRecovery: {
              phase: "accepted",
              sessionId: "lost-session",
              sessionMarker: "lost-session:1",
              idempotencyKey: "lost-recovery",
            },
          },
        }),
      ).toMatchObject({ status: "terminal", suppressSessionEffects: true });
      expectAbsent();

      await replaceSessionEntry(
        { agentId: "main", sessionKey: childSessionKey },
        {
          sessionId: "successor-session",
          lifecycleRevision: "successor-lifecycle",
          updatedAt: Date.now(),
        },
      );
      if (storage === "durable") {
        expect(result.recoveryCurrent?.isHostCurrent()).toBe(false);
        expect(await result.recoveryCurrent?.prepare()).toBe(false);
        expect(await result.sessionEffects?.isCurrent()).toBe(false);
      }
      const missingRow = await recover({ ...entry, childSessionKey: `${childSessionKey}-other` });
      expect(missingRow.status).toBe("terminal");
      if (missingRow.status === "terminal") {
        expect(missingRow.suppressSessionEffects).not.toBe(true);
      }
    });
  },
);

describe("subagent orphan recovery — faithful restart path", () => {
  const fixture = useSubagentRestartRecoveryFixture({ reuseDatabaseWorkers: true });
  const { activateGatewayRuntime, dispatchAgent, gatewayRuntime } = fixture;
  const { writeSession, childFixture } = createRecoverySessions(fixture);

  it("recovers a raw child key using its recorded owner without borrowing another agent's session", async () => {
    const child = await rawChildFixture("recovery");
    const { runId, childSessionKey, startedAt, mainBefore } = child;
    const entry = child.run({
      execution: { status: "interrupted", startedAt },
    });
    const warn = vi.fn();
    const result = await recoverInterruptedSubagentRow({
      entry,
      runId,
      gatewayRuntime,
      isCurrent: () => true,
      warn,
    });
    if (result.status !== "terminal") {
      throw new Error("Expected raw child recovery to retain its recorded agent");
    }
    expect(result.suppressSessionEffects).not.toBe(true);
    expect(await result.sessionEffects?.isCurrent()).toBe(true);
    expect(await result.recoveryCurrent?.prepare()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(readSession(childSessionKey)).toEqual(mainBefore);
    expect(dispatchAgent).not.toHaveBeenCalled();
    const ownerless = await recoverInterruptedSubagentRow({
      entry: { ...entry, childAgentId: undefined },
      runId,
      gatewayRuntime,
      isCurrent: () => true,
      warn,
    });
    expect(ownerless).toEqual({ status: "deferred" });
    expect(warn).toHaveBeenCalledWith(
      "retained subagent record cannot be recovered",
      expect.objectContaining({
        error: expect.objectContaining({
          message:
            "Cannot operate on this subagent because its owning agent is unresolved. No child work was changed. Inspect the retained record and original execution evidence before retrying.",
        }),
      }),
    );
  });
  it("restores a completed raw-key child from its recorded agent instead of an aborted namesake", async () => {
    const child = await rawChildFixture("restore");
    const { runId, childSessionKey, startedAt, endedAt, mainBefore } = child;
    expect(mainBefore).toMatchObject({
      sessionId: "main-restore-session",
      status: "interrupted",
      abortedLastRun: true,
    });
    const recovered = child.run({
      createdAt: startedAt,
      expectsCompletionMessage: true,
      endedReason: "subagent-complete",
      execution: { status: "terminal", startedAt, endedAt, outcome: { status: "ok" } },
      completion: { required: true, resultText: "Research result", capturedAt: endedAt },
      delivery: { status: "pending" },
    });
    await prepareSubagentRecoveryFixture(recovered, { stateDir: fixture.stateDir });
    await addSubagentRunForTests(recovered);
    await fixture.settle();
    await resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    expect(subagentRuns.has(runId)).toBe(false);
    await initSubagentRegistry();
    await activateGatewayRuntime();
    await fixture.settle();

    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({ childRunId: runId, outcome: { status: "ok" } }),
    );
    expect(readPersisted(runId)).toMatchObject({
      childAgentId: "research",
      cleanupCompletedAt: expect.any(Number),
      execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
      delivery: { status: "delivered" },
    });
    expect(readSession(childSessionKey)).toEqual(mainBefore);
    expect(readSession(childSessionKey, "research")).toMatchObject({
      sessionId: "research-restore-session",
      status: "done",
      abortedLastRun: false,
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it.each(["idle", "done"] as const)(
    "settles a replaced child once when its parent is %s across restarts",
    async (parentStatus) => {
      const entry = makeRunRecord({
        runId: "replaced-child-run",
        childSessionIdentity: {
          sessionId: "original-child",
          lifecycleRevision: "original-revision",
        },
        requesterSessionKey: "agent:main:replacement-parent",
        requesterTurnRunId: "original-parent-run",
        expectsCompletionMessage: false,
        completionRequesterSessionId: "original-parent",
        completionRequesterLifecycleRevision: "parent-revision",
        execution: {
          status: "interrupted",
          interruptionReason: "gateway-restart",
          startedAt: Date.now() - 1_000,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
      });
      await replaceSessionEntry(
        { agentId: "main", sessionKey: entry.requesterSessionKey },
        {
          sessionId: "original-parent",
          lifecycleRevision: "parent-revision",
          updatedAt: Date.now(),
          status: parentStatus === "done" ? "done" : undefined,
        },
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: entry.childSessionKey },
        {
          sessionId: "replacement-child",
          lifecycleRevision: "replacement-revision",
          lifecycleRunId: "replacement-run",
          updatedAt: Date.now(),
          status: "done",
        },
      );
      const replacement = readSession(entry.childSessionKey);
      await addSubagentRunForTests(entry);
      await fixture.settle();
      await restartRegistry(fixture);
      await testing.sweepOnceForTests();
      const settled = readPersisted(entry.runId);
      expect(settled).toMatchObject({
        execution: {
          status: "terminal",
          suppressSessionEffects: true,
          outcome: {
            status: "error",
            error: expect.stringContaining("original session incarnation changed"),
          },
        },
        completionTarget: "parent",
      });
      expect(settled?.requesterTurnRunId).toBeUndefined();
      expect(readSession(entry.childSessionKey)).toEqual(replacement);
      const endedAt = settled?.execution.endedAt;
      await restartRegistry(fixture);
      expect(readPersisted(entry.runId)?.execution.endedAt).toBe(endedAt);
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );
  registerRecoveredTerminalTailTest(fixture);

  it("reconciles retained predecessor sessions during startup without waiting for a sweep", async () => {
    const startedAt = Math.floor(performance.timeOrigin) - 60_000;
    const generation = getAgentEventLifecycleGeneration();
    const records = Array.from({ length: 5 }, (_, index) =>
      makeRunRecord({
        runId: `retained-startup-${index}`,
        childSessionKey: `agent:main:subagent:retained-startup-${index}`,
        childSessionIdentity: {
          sessionId: `retained-startup-${index}`,
          lifecycleRevision: `retained-startup-${index}`,
        },
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
          status: undefined,
          startedAt,
          updatedAt: startedAt,
        },
      );
      await addSubagentRunForTests(entry);
    }
    await fixture.settle();
    await resetSubagentRegistryForTests({ persist: false });
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
        await runStartupSessionMaintenanceForTest({
          cfg: { agents: { entries: { main: {} } } },
          log,
        });
        await initSubagentRegistry();
        await activateGatewayRuntime();
        await fixture.settle();
        for (const entry of records) {
          expect(readSession(entry.childSessionKey)).toMatchObject({
            status: "interrupted",
            abortedLastRun: true,
            endedAt: expect.any(Number),
            lastRunError: "Run interrupted by a Gateway restart.",
          });
          expect(readPersisted(entry.runId)?.execution).toMatchObject({
            status: "terminal",
            outcome: { status: "error" },
          });
        }
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(log.warn.mock.calls).toEqual([]);
      });
    } finally {
      // Stop recovery scheduling before closing the Gateway database owner.
      await resetSubagentRegistryForTests({ persist: false });
      await fixture.settle();
      try {
        // A Gateway closes agent databases before retiring its shared-state owner.
        await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
      } finally {
        await lock.release();
      }
    }
  });

  it.for([
    ["restart", "lifecycle then wait", "interrupted", undefined],
    ["restart", "wait only", "interrupted", undefined],
    ["restart", "retired wait", "running", undefined],
    ["restart", "retired wait retry", "running", undefined],
    ["restart", "closed state wait retry", "running", undefined],
    ["aborted", "lifecycle then wait", "terminal", undefined],
    ["restart", "lifecycle then wait", "terminal", "provider"],
    ["restart", "restart then rejected wait", "interrupted", undefined],
    ["restart", "restart then soft timeout", "interrupted", undefined],
    ["error", "restart then provider error", "terminal", undefined],
    ["restart", "restart then provider timeout", "terminal", "provider"],
    ["aborted", "restart then user cancel", "terminal", undefined],
  ] as const)(
    "preserves %s through %s as %s (timeout: %s)",
    async ([stopReason, source, expected, timeoutPhase], { signal }) => {
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
          status: undefined,
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
      const interruptedPersisted = createDeferred();
      const terminalPersisted = createDeferred();
      const stopObservingPublication = subscribeSubagentRunChanges("persistence", () => {
        const executionStatus = readPersisted(runId)?.execution.status;
        if (executionStatus === "interrupted") {
          interruptedPersisted.resolve();
        }
        if (executionStatus === "terminal") {
          terminalPersisted.resolve();
        }
      });
      onTestFinished(stopObservingPublication);
      try {
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          await registerSubagentRun({
            runId,
            childSessionKey,
            childAgentId: "main",
            sessionEntry: { sessionId: "live-restart-child-session" },
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
              await interruptedPersisted.promise;
              expect(readPersisted(runId)?.execution.status).toBe("interrupted");
            } else if (expected === "interrupted") {
              await vi.waitFor(() =>
                expect(readPersisted(runId)?.execution.status).not.toBe("running"),
              );
            }
          } else if (source === "retired wait") {
            rotateAgentEventLifecycleGeneration();
          }
          if (source === "retired wait retry" || source === "closed state wait retry") {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const waitReleased = createDeferred();
            const retain = gatewayWorkAdmission.retainGatewayRootWorkAdmissionContinuation;
            let observedContinuations = 0;
            const observation = vi
              .spyOn(gatewayWorkAdmission, "retainGatewayRootWorkAdmissionContinuation")
              .mockImplementation(() => {
                const release = retain();
                const ownsTestRoot =
                  gatewayWorkAdmission
                    .getActiveGatewayRootWorkHolders()
                    .includes("test:admitted-agent") &&
                  !gatewayWorkAdmission
                    .getActiveGatewayRootWorkHolders({ excludeCurrent: true })
                    .includes("test:admitted-agent");
                if (!release || !ownsTestRoot) {
                  return release;
                }
                observedContinuations += 1;
                return () => {
                  try {
                    release();
                  } finally {
                    waitReleased.resolve();
                  }
                };
              });
            try {
              oldWait.reject(new Error("gateway request timeout"));
              // The wait releases its continuation after real reads and retry scheduling.
              await withinTest(waitReleased.promise, signal);
              expect(observedContinuations).toBe(1);
              expect(vi.getTimerCount()).toBeGreaterThan(0);
              if (source === "closed state wait retry") {
                await fixture.withStateReadAdmissionClosed(async () => {
                  expect(() => captureOpenClawStateWorkerContext()).toThrow(
                    "read admission is closed",
                  );
                  await vi.advanceTimersByTimeAsync(25);
                });
              } else {
                rotateAgentEventLifecycleGeneration();
                await vi.advanceTimersByTimeAsync(1_000);
              }
              expect(waitRequests.filter((id) => id === runId)).toHaveLength(1);
            } finally {
              observation.mockRestore();
              vi.useRealTimers();
            }
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
        // The wait can still be reconciling worker reads after its spawning admission returns.
        if (expected === "terminal") {
          await terminalPersisted.promise;
        }
        await fixture.settle();

        const persisted = readPersisted(runId);
        expect(persisted?.execution.status).toBe(expected);
        if (expected === "terminal") {
          expect(persisted?.execution.outcome?.status).toBe(timeoutPhase ? "timeout" : "error");
          expect(persisted?.execution.interruptionReason).toBeUndefined();
          expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe(
            timeoutPhase ? "timeout" : stopReason === "error" ? "failed" : "killed",
          );
          return;
        }
        if (expected === "interrupted") {
          expect(persisted?.execution.interruptionReason).toBe("gateway-restart");
        }
        expect(persisted?.execution.endedAt).toBeUndefined();
        // The retired task registry reported every unended run as running; sessions keep the interruption.
        expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe(expected);

        await restartRegistry(fixture, resetGatewayWorkAdmission);
        await testing.sweepOnceForTests();
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(await readChildRun(childSessionKey)).toMatchObject({
          runId,
          execution: { status: "terminal", outcome: { status: "error" } },
        });
      } finally {
        if (source === "retired wait retry" || source === "closed state wait retry") {
          vi.useRealTimers();
        }
        oldWait.resolve(waitResult);
        try {
          await fixture.settle();
        } finally {
          stopObservingPublication();
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
      const child = childFixture("interrupted-commit-race");
      const { runId, childSessionKey, sessionId } = child;
      const storePath = await child.write({ abortedLastRun: true });
      const entry = child.run();
      await addSubagentRunForTests(entry);
      const entered = createDeferred();
      const release = createDeferred();
      const prototype = SubagentLifecycleController.prototype;
      const acquire = vi.spyOn(prototype, "acquireTerminalCompletionLock");
      acquire.mockRestore();
      const lock = vi
        .spyOn(prototype, "acquireTerminalCompletionLock")
        .mockImplementation(async function (this: SubagentLifecycleController, targetRunId) {
          const unlock = await acquire.call(this, targetRunId);
          if (targetRunId === runId) {
            entered.resolve();
            await release.promise;
          }
          return unlock;
        });
      const pending = testing.sweepOnceForTests();
      let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
      try {
        await entered.promise;
        if (owner === "run") {
          registerAgentRunContext("fresh-execution", { sessionKey: childSessionKey, sessionId });
        } else {
          admission = await beginSessionEffect({
            scope: storePath,
            identities: [childSessionKey, sessionId],
            assertAllowed: () => {},
          });
        }
        release.resolve();
        await pending;
        const current = subagentRuns.get(runId);
        expect(current).toBeDefined();
        expect(current?.execution.endedAt).toBeUndefined();
        expect(current?.execution.outcome).toBeUndefined();
        expect(current?.terminalOwner).toBeUndefined();
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

  it.each(["run", "admission", "replaced", "missing", "original", "unclassified"] as const)(
    "reconciles historical child status while preserving the %s owner",
    async (owner) => {
      const now = Date.now();
      const child = childFixture("saved-terminal-replay");
      const { runId, childSessionKey, sessionId } = child;
      const storePath = await child.write();
      await patchSessionEntryCore({ storePath, sessionKey: childSessionKey }, (entry) => ({
        ...entry,
        lifecycleRunId: owner === "run" ? "fresh-execution" : runId,
        status: owner === "run" ? undefined : "failed",
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
            status: undefined,
            updatedAt: now,
          },
        );
      }
      const entry = child.run({
        expectsCompletionMessage: true,
        endedReason: "subagent-error",
        terminalOwner: owner === "unclassified" ? undefined : "interrupted-recovery",
        cleanupCompletedAt: owner === "unclassified" ? now : undefined,
        cleanupHandled: owner === "unclassified" ? true : undefined,
        execution: {
          status: "terminal",
          endedAt: now,
          outcome: { status: "error", error: "Saved restart outcome" },
        },
        completion: { required: true, resultText: null, capturedAt: now },
      });
      if (owner === "original") {
        await prepareSubagentRecoveryFixture(entry, { stateDir: fixture.stateDir });
      } else if (owner !== "unclassified") {
        await writeSession({
          sessionKey: entry.requesterSessionKey,
          defaultSessionId: "recovery-requester-session",
          lifecycleRevision: "recovery-requester-revision",
        });
      }
      await addSubagentRunForTests(entry);
      if (owner === "original" || owner === "unclassified") {
        expect(readPersisted(runId)?.execution.interruptionReason).toBeUndefined();
        await restartRegistry(fixture, () =>
          cleanupSessionStateForTest({ stateDir: fixture.stateDir }),
        );
      }
      let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
      try {
        if (owner === "run") {
          registerAgentRunContext("fresh-execution", { sessionKey: childSessionKey, sessionId });
        } else if (owner === "admission") {
          admission = await beginSessionEffect({
            scope: storePath,
            identities: [childSessionKey, sessionId],
            assertAllowed: () => {},
          });
        }
        const before = child.read();
        await testing.sweepOnceForTests();
        if (owner === "unclassified") {
          expect(child.read()).toEqual(before);
          expect(
            (await readChildRun(childSessionKey))?.execution.interruptionReason,
          ).toBeUndefined();
          return;
        }
        // A concurrent sweep skips recovery already owned by startup.
        await fixture.settle();
        expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
          expect.objectContaining({
            childRunId: runId,
            outcome: expect.objectContaining({ status: "error", error: "Saved restart outcome" }),
            suppressChildSessionEffects: owner !== "original",
          }),
        );
        expect(cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(
          owner === "original" ? 1 : 0,
        );
        if (owner !== "original") {
          expect(child.read()).toEqual(before);
        } else {
          expect(child.read()).toMatchObject({ status: "interrupted" });
          expect((await readChildRun(childSessionKey))?.execution.interruptionReason).toBe(
            "gateway-restart",
          );
        }
      } finally {
        admission?.release();
        clearAgentRunContext("fresh-execution");
      }
    },
  );

  it.each([
    [3 * TWO_HOURS_MS, 3 * TWO_HOURS_MS, undefined],
    [60_000, 0, 0],
    [3 * TWO_HOURS_MS, 0, 0],
  ] as const)(
    "settles an interrupted run started %i ms ago and updated %i ms ago (timeout: %s) without replay",
    async (runAgeMs, sessionAgeMs, runTimeoutSeconds) => {
      const now = Date.now();
      const child = childFixture("fresh-aborted");
      const { runId, childSessionKey, sessionId } = child;
      const storePath = await child.write({ updatedAt: now - sessionAgeMs, abortedLastRun: true });
      const record = child.run({
        createdAt: now - runAgeMs,
        startedAt: now - runAgeMs,
        runTimeoutSeconds,
      });
      await addSubagentRunForTests(record);

      await testing.sweepOnceForTests();

      const after = await readChildRun(childSessionKey);
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(after).toMatchObject({
        runId,
        execution: {
          status: "terminal",
          endedAt: expect.any(Number),
          outcome: { status: "error" },
        },
      });
      await cleanupSessionStateForTest();
      const persistedSession = (await readSubagentSessionStore(storePath))[childSessionKey];
      expect(persistedSession).toMatchObject({
        status: "interrupted",
        endedAt: expect.any(Number),
        abortedLastRun: true,
      });
      const transcript = await loadTranscriptEvents({
        agentId: "main",
        storePath,
        sessionKey: childSessionKey,
        sessionId,
      });
      expect(
        transcript.filter(
          (event) => isRecord(event) && event.customType === "run-failed-before-reply",
        ),
      ).toEqual([]);
    },
  );

  it.each([false, true])(
    "keeps replaced hidden-session cleanup admitted until deletion completes (restart fenced: %s)",
    async (restartFenced) => {
      const child = childFixture("held-hidden-cleanup");
      const { runId, childSessionKey, sessionId } = child;
      const nextRunId = "held-hidden-cleanup-successor";
      const storePath = await child.write();
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
      });
      await addSubagentRunForTests(
        child.run({
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
            await replaceSubagentRunAfterSteerCore({
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
          await fixture.settle();
          // Settle the original untracked deletion too when the ownership assertion fails.
          await vi.waitFor(() => expect(loadExactSessionEntry(retired)).toBeUndefined());
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
    const child = childFixture("retired-accepted", null);
    const { childSessionKey, runId, sessionId } = child;
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const storePath = await child.write({ updatedAt: now, abortedLastRun: true });
    const record = child.run({
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      execution: {
        status: "interrupted",
        startedAt: now - 55_000,
        restartRecovery: {
          sessionId,
          sessionMarker: "sess-retired-accepted:1",
          idempotencyKey: "subagent-recovery:retired-accepted",
          phase: "accepted",
          lifecycleGeneration: priorLifecycleGeneration,
        },
      },
    });
    await prepareSubagentRecoveryFixture(record, { stateDir: fixture.stateDir });
    await addSubagentRunForTests(record);
    const expectSuppressed = async (entry: ReturnType<typeof subagentRuns.get>) => {
      expect(entry).toMatchObject({
        execution: { status: "terminal", suppressSessionEffects: true },
      });
      expect(entry?.execution.restartRecovery).toBeUndefined();
      expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
        abortedLastRun: true,
      });
    };

    await fixture.settle();
    await restartRegistry(fixture);
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
    await expectSuppressed(readPersisted(runId));

    await restartRegistry(fixture);
    await testing.sweepOnceForTests();

    const restoredAgain = subagentRuns.get(runId);
    expect(restoredAgain).toMatchObject({
      execution: { status: "terminal", suppressSessionEffects: true },
    });
    await fixture.settle();
    await expectSuppressed(restoredAgain);
  });

  it("finalizes only a stale predecessor when a fresh generation shares its child session", async () => {
    const now = Date.now();
    const child = childFixture("shared-generation", null);
    const staleRecord = child.run({
      runId: "run-stale-generation",
      generation: 1,
      createdAt: now - 3 * 60 * 60 * 1_000,
      startedAt: now - 3 * 60 * 60 * 1_000,
      sessionStartedAt: now - 3 * 60 * 60 * 1_000,
    });
    const freshRecord = child.run({
      runId: "run-fresh-generation",
      generation: 2,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      sessionStartedAt: now - 60_000,
    });
    await addSubagentRunForTests(staleRecord);
    await addSubagentRunForTests(freshRecord);

    await child.write({ updatedAt: now, abortedLastRun: true });
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
  });
});
