import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { prepareSubagentKillSession } from "./subagent-control-session.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { reconcileDurableSubagentKillIntent } from "./subagent-registry-sweep-kill.js";
import { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";
import {
  createArchivedSubagentSweeperRun as archivedRun,
  createSubagentSweeperChildLookup as childRuns,
  createSubagentSweeperHarness as createHarness,
  createSubagentSweeperRun as run,
} from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

const recoverRow = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn<(_runId: string) => unknown>(() => undefined));
const removeInternalSessionEffectsSession = vi.hoisted(() => vi.fn(async () => {}));
const killRuntime = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn(() => false),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  clearSessionLifecycleQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
}));
const killSessionEntry = vi.hoisted(() => ({
  current: undefined as
    | { sessionId: string; lifecycleRevision?: string; updatedAt: number }
    | undefined,
}));
vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>();
  return {
    ...actual,
    recoverInterruptedSubagentRow: recoverRow,
  };
});
vi.mock("../../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/agent-run-registry.js")>()),
  getAgentRunContext,
}));
vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession,
}));
vi.mock("./subagent-control.runtime.js", () => killRuntime);
vi.mock("./subagent-control-session.js", { spy: true });
vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-session-reconciliation.js")>();
  return {
    ...actual,
    loadSubagentSessionEntry: vi.fn(() => killSessionEntry.current),
  };
});

describe("subagent registry recovery scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    recoverRow.mockReset();
    vi.mocked(loadSubagentSessionEntry)
      .mockReset()
      .mockImplementation(() => killSessionEntry.current);
    vi.mocked(prepareSubagentKillSession).mockImplementation(async (_cfg, _key, assertOwner) => {
      assertOwner();
      return {
        agentId: "main",
        storePath: "/synthetic-kill/sessions.sqlite",
        entry: killSessionEntry.current,
        assertCurrent: assertOwner,
        prepareRead: () => undefined,
        withPublication: async (publish) => await publish(),
        release: () => {},
      };
    });
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    killRuntime.abortEmbeddedAgentRun.mockReset().mockReturnValue(false);
    killRuntime.isEmbeddedAgentRunActive.mockReset().mockReturnValue(false);
    killRuntime.clearSessionLifecycleQueues.mockReset().mockReturnValue({
      followupCleared: 0,
      laneCleared: 0,
      keys: [],
    });
    killSessionEntry.current = {
      sessionId: "session-id",
      lifecycleRevision: "session-revision",
      updatedAt: Date.now(),
    };
    removeInternalSessionEffectsSession.mockReset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it.each(["terminal", "running"] as const)(
    "only gives ended %s children requester-wake priority over suspended delivery cleanup",
    async (executionStatus) => {
      const { entry, resumeRequesterSettleWake, completeCleanupBookkeeping, sweeper } =
        createHarness({});
      entry.execution = {
        status: executionStatus,
        endedAt: Date.now() - 60_000,
        outcome: { status: "ok" },
      };
      entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
      entry.delivery = {
        status: "suspended",
        suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
        suspendedReason: "expiry",
      };

      await sweeper.sweepOnce();

      expect(resumeRequesterSettleWake).toHaveBeenCalledTimes(
        executionStatus === "terminal" ? 1 : 0,
      );
      if (executionStatus === "terminal") {
        expect(completeCleanupBookkeeping).not.toHaveBeenCalled();
      }
    },
  );

  it("observes a sibling completion committed while another completion is awaiting", async () => {
    const actual = await vi.importActual<typeof import("./subagent-session-reconciliation.js")>(
      "./subagent-session-reconciliation.js",
    );
    await vi
      .mocked(loadSubagentSessionEntry)
      .withImplementation(actual.loadSubagentSessionEntry, async () => {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          recoverRow.mockResolvedValue({ status: "ignored" });
          const { entry, runs, completeSubagentRunWithRecovery, sweeper } = createHarness({
            current: {} as GatewayRecoveryRuntime,
          });
          const sibling = {
            ...run(),
            runId: "sibling-run",
            childSessionKey: "agent:main:subagent:sibling",
          };
          runs.set(sibling.runId, sibling);
          const sessionEntry = {
            sessionId: "child-session",
            startedAt: entry.execution.startedAt,
            updatedAt: Date.now(),
          };
          replaceSessionEntrySync(
            { sessionKey: entry.childSessionKey, env: state.env },
            { ...sessionEntry, status: "done", endedAt: Date.now() },
          );
          replaceSessionEntrySync(
            { sessionKey: sibling.childSessionKey, env: state.env },
            { ...sessionEntry, sessionId: "sibling-session", status: undefined },
          );
          const completion = createDeferred();
          completeSubagentRunWithRecovery.mockReturnValueOnce(completion.promise);
          const pending = sweeper.sweepOnce();
          try {
            await vi.waitFor(() => expect(completeSubagentRunWithRecovery).toHaveBeenCalledOnce());
            replaceSessionEntrySync(
              { sessionKey: sibling.childSessionKey, env: state.env },
              {
                ...sessionEntry,
                sessionId: "sibling-session",
                status: "done",
                endedAt: Date.now(),
              },
            );
            completion.resolve();
            await pending;
            expect(completeSubagentRunWithRecovery).toHaveBeenLastCalledWith(
              expect.objectContaining({ runId: sibling.runId, outcome: { status: "ok" } }),
              "sweeper-session-completion",
            );
          } finally {
            completion.resolve();
            await pending;
            await sweeper.reset();
          }
        });
      });
  });

  it.each(["lifecycle", "runtime"] as const)(
    "does not finalize interrupted work after its Gateway %s changes during classification",
    async (change) => {
      const runtime = { current: {} as GatewayRecoveryRuntime };
      const classification = createDeferred<{ status: "terminal"; error: string }>();
      recoverRow.mockReturnValue(classification.promise);
      const { finalizeInterruptedSubagentRun, completeSubagentRunWithRecovery, sweeper } =
        createHarness(runtime);
      const pending = sweeper.sweepOnce();
      try {
        await vi.waitFor(() => expect(recoverRow).toHaveBeenCalledOnce());
        if (change === "lifecycle") {
          rotateAgentEventLifecycleGeneration();
        } else {
          runtime.current = {} as GatewayRecoveryRuntime;
        }
      } finally {
        classification.resolve({ status: "terminal", error: "Gateway restart" });
        await pending;
      }
      expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
      expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
    },
  );

  it("retries terminal settlement without dispatching a child", async () => {
    recoverRow.mockResolvedValue({ status: "terminal", error: "Gateway restart" });
    const { entry, finalizeInterruptedSubagentRun, sweeper } = createHarness({});
    finalizeInterruptedSubagentRun.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(2);
    expect(
      finalizeInterruptedSubagentRun.mock.calls.every(([params]) => params.expectedEntry === entry),
    ).toBe(true);
  });

  it.each(["ordinary", "collector group", "collector launch"])(
    "preserves a reset sibling during an earlier await in %s cleanup",
    async (kind) => {
      const actual = await vi.importActual<typeof import("./subagent-session-reconciliation.js")>(
        "./subagent-session-reconciliation.js",
      );
      await vi
        .mocked(loadSubagentSessionEntry)
        .withImplementation(actual.loadSubagentSessionEntry, async () => {
          await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
            const { entry, runs, callGateway, sweeper } = createHarness({}, archivedRun());
            const sibling = archivedRun({
              runId: "sibling-run",
              childSessionKey: "agent:main:subagent:sibling",
              ...(kind !== "ordinary"
                ? { collect: true, groupId: "group", collectorCompletion: { status: "done" } }
                : {}),
              collectorLaunchCleanupPending: kind === "collector launch",
            });
            runs.set(sibling.runId, sibling);
            const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
            for (const child of [entry, sibling]) {
              replaceSessionEntrySync(
                { sessionKey: child.childSessionKey, env: state.env },
                {
                  sessionId: child.runId,
                  lifecycleRevision: "original-revision",
                  updatedAt: Date.now(),
                },
              );
            }
            callGateway.mockImplementation(async ({ params: request }) => {
              if (request.key === entry.childSessionKey) {
                await resetSessionEntryLifecycle({
                  agentId: "main",
                  storePath,
                  target: {
                    canonicalKey: sibling.childSessionKey,
                    storeKeys: [sibling.childSessionKey],
                  },
                  buildNextEntry: ({ currentEntry }) => ({
                    ...currentEntry,
                    sessionId: sibling.runId,
                    lifecycleRevision: "reset-revision",
                    updatedAt: Date.now(),
                  }),
                });
              }
              const deleted = await deleteSessionEntryLifecycle({
                agentId: "main",
                storePath,
                target: { canonicalKey: request.key, storeKeys: [request.key] },
                expectedSessionId: request.expectedSessionId,
                expectedLifecycleRevision: request.expectedLifecycleRevision,
                archiveTranscript: false,
                deleteTranscriptWithoutArchive: true,
              });
              if (deleted.expectedEntryMismatch) {
                throw Object.assign(new Error("session changed"), {
                  name: "GatewayClientRequestError",
                  gatewayCode: "INVALID_REQUEST",
                  details: { reason: "session-changed" },
                });
              }
              return deleted;
            });
            try {
              await sweeper.sweepOnce();
              expect(
                loadSessionEntryReadOnly({ sessionKey: entry.childSessionKey }),
              ).toBeUndefined();
              expect(
                loadSessionEntryReadOnly({ sessionKey: sibling.childSessionKey }),
              ).toMatchObject({
                sessionId: sibling.runId,
                lifecycleRevision: "reset-revision",
              });
            } finally {
              await sweeper.reset();
            }
          });
        });
    },
  );

  it.each([
    { change: "replacement", suppressed: false },
    { change: "replacement", suppressed: true },
    { change: "new member", suppressed: false },
    { change: "new member", suppressed: true },
  ])(
    "defers a collector group with a $change after an earlier cleanup await (suppressed: $suppressed)",
    async ({ change, suppressed }) => {
      const { entry, runs, callGateway, sweeper } = createHarness({}, archivedRun());
      const collector = (runId: string) =>
        archivedRun({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          collect: true,
          groupId: "group",
          collectorCompletion: { status: "done" },
        });
      const sibling = collector("sibling");
      const groupmate = collector("groupmate");
      runs.set(sibling.runId, sibling);
      runs.set(groupmate.runId, groupmate);
      const changed = collector(change === "replacement" ? sibling.runId : "new-member");
      if (change === "replacement") {
        changed.generation = (sibling.generation ?? 0) + 1;
      }
      if (suppressed) {
        changed.execution.suppressSessionEffects = true;
      }
      callGateway.mockImplementationOnce(async () => {
        await Promise.resolve();
        runs.set(changed.runId, changed);
        return {};
      });

      await sweeper.sweepOnce();

      expect(callGateway).toHaveBeenCalledOnce();
      expect(runs.has(entry.runId)).toBe(false);
      expect(runs.get(changed.runId)).toBe(changed);
      expect(changed.execution.suppressSessionEffects).toBe(suppressed ? true : undefined);
      expect(runs.get(groupmate.runId)).toBe(groupmate);
    },
  );

  it("drops a stale terminal retry when a newer generation wins during finalization", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "terminal", error: "interrupted" });
    const { entry, runs, finalizeInterruptedSubagentRun, sweeper } = createHarness(runtime);
    const finalization = createDeferred<number>();
    finalizeInterruptedSubagentRun.mockReturnValueOnce(finalization.promise);

    const pending = sweeper.sweepOnce();
    try {
      await vi.waitFor(() => expect(finalizeInterruptedSubagentRun).toHaveBeenCalledOnce());
      const newer = run();
      newer.runId = "newer-recovery-run";
      newer.generation = (entry.generation ?? 0) + 1;
      runs.set(newer.runId, newer);
    } finally {
      finalization.resolve(0);
      await pending;
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
  });

  it("coalesces duplicate schedules before the owner pass starts", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "ignored" });
    const { sweeper } = createHarness(runtime);

    sweeper.schedule({ delayMs: 1 });
    sweeper.schedule({ delayMs: 1 });
    await vi.advanceTimersByTimeAsync(1);

    expect(recoverRow).toHaveBeenCalledOnce();
  });

  it("rechecks deferred ownership when the runtime becomes available", async () => {
    const runtime: { current?: GatewayRecoveryRuntime } = {};
    recoverRow.mockImplementation(async ({ gatewayRuntime }) =>
      gatewayRuntime ? { status: "ignored" } : { status: "deferred" },
    );
    const { finalizeInterruptedSubagentRun, sweeper } = createHarness(runtime);

    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    runtime.current = {} as GatewayRecoveryRuntime;
    await sweeper.sweepOnce();

    expect(recoverRow).toHaveBeenCalledTimes(3);
    expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
  });

  it("backs off each unresolved row without a sibling sweep resetting its deadline", async () => {
    recoverRow.mockResolvedValue({ status: "deferred" });
    const { entry, runs, finalizeInterruptedSubagentRun, sweeper } = createHarness({});
    const calls = () =>
      recoverRow.mock.calls.filter(([params]) => params.runId === entry.runId).length;
    await sweeper.sweepOnce();
    for (const { delay, expected } of [
      { delay: 1_000, expected: 2 },
      { delay: 2_000, expected: 3 },
      { delay: 4_000, expected: 4 },
      { delay: 8_000, expected: 5 },
      { delay: 16_000, expected: 6 },
      { delay: 32_000, expected: 7 },
      { delay: 60_000, expected: 8 },
      { delay: 60_000, expected: 9 },
    ]) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(calls()).toBe(expected);
    }
    const sibling = { ...run(), runId: "new-sibling", childSessionKey: "agent:main:subagent:new" };
    runs.set(sibling.runId, sibling);
    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(calls()).toBe(9);
    expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
  });

  it.each(["session", "registry", "generation"] as const)(
    "rechecks a changed %s without waiting for the row's backoff",
    async (change) => {
      recoverRow.mockResolvedValue({ status: "deferred" });
      const { entry, runs, sweeper } = createHarness({});
      await sweeper.sweepOnce();
      await vi.advanceTimersByTimeAsync(7_000);
      expect(recoverRow).toHaveBeenCalledTimes(4);
      recoverRow.mockResolvedValue({ status: "handled" });
      if (change === "session") {
        sessionChanges.emit({ sessionKey: entry.childSessionKey, scope: "session-entry" });
        await vi.advanceTimersByTimeAsync(1_000);
      } else {
        if (change === "registry") {
          runs.set(entry.runId, {
            ...entry,
            execution: { ...entry.execution, status: "interrupted" },
          });
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        await sweeper.sweepOnce();
      }
      expect(recoverRow).toHaveBeenCalledTimes(5);
    },
  );

  it("does not terminalize a durable kill intent while runtime abort is rejected", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness(runtime);
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionLifecycleRevision: "session-revision",
    };
    getAgentRunContext.mockReturnValue({});
    killRuntime.isEmbeddedAgentRunActive.mockReturnValue(true);

    await sweeper.sweepOnce();

    expect(killRuntime.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-id");
    expect(killRuntime.clearSessionLifecycleQueues).toHaveBeenCalledWith({
      keys: [entry.childSessionKey, "session-id"],
      agentId: "main",
      sessionKey: entry.childSessionKey,
      sessionId: "session-id",
      assertCurrent: expect.any(Function),
    });
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();

    getAgentRunContext.mockReturnValue(undefined);
    killRuntime.isEmbeddedAgentRunActive.mockReturnValue(false);
    await sweeper.sweepOnce();

    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        reason: "subagent-killed",
      }),
      "sweeper-pending-kill-intent",
    );
  });

  it("reconciles a raw child's kill intent in its recorded agent's configured store", async () => {
    const actual = await vi.importActual<typeof import("./subagent-control-session.js")>(
      "./subagent-control-session.js",
    );
    await vi
      .mocked(prepareSubagentKillSession)
      .withImplementation(actual.prepareSubagentKillSession, async () => {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const { entry, runs, completeSubagentRunWithRecovery } = createHarness({});
          entry.childSessionKey = "global";
          entry.childAgentId = "research";
          const cfg = getRuntimeConfig();
          const storePath = resolveSessionStorePathCore(cfg.session?.store, {
            agentId: "research",
          });
          replaceSessionEntrySync(
            { agentId: "research", storePath, sessionKey: "global", env: state.env },
            {
              sessionId: "research-session",
              lifecycleRevision: "research-revision",
              updatedAt: Date.now(),
            },
          );
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "global", env: state.env },
            {
              sessionId: "main-session",
              lifecycleRevision: "main-revision",
              updatedAt: Date.now(),
            },
          );
          entry.killIntent = {
            requestedAt: Date.now(),
            reason: "killed",
            sessionId: "research-session",
            sessionLifecycleRevision: "research-revision",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          };
          const foreign = {
            ...entry,
            runId: "main-foreign-run",
            generation: (entry.generation ?? 0) + 1,
            createdAt: entry.createdAt + 1,
            childAgentId: "main",
            killIntent: undefined,
          };
          runs.set(foreign.runId, foreign);
          killRuntime.isEmbeddedAgentRunActive.mockReturnValue(true);
          killRuntime.abortEmbeddedAgentRun.mockReturnValue(true);
          const sql = observeMainThreadSql();
          try {
            expect(
              await reconcileDurableSubagentKillIntent({
                runId: entry.runId,
                entry,
                runs,
                getRunsForChildSession: childRuns(runs),
                loadKillRuntime: async () => killRuntime,
                completeSubagentRunWithRecovery,
                retireSupersededRun: vi.fn(),
                warn: vi.fn(),
              }),
            ).toBe(true);
            sql.expectIdle();
          } finally {
            sql.restore();
          }
          expect(killRuntime.abortEmbeddedAgentRun).toHaveBeenCalledExactlyOnceWith(
            "research-session",
          );
          expect(killRuntime.clearSessionLifecycleQueues).toHaveBeenCalledExactlyOnceWith({
            keys: ["global", "research-session"],
            agentId: "research",
            sessionKey: "global",
            sessionId: "research-session",
            assertCurrent: expect.any(Function),
          });
          expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
            expect.not.objectContaining({ suppressSessionEffects: true }),
            "sweeper-pending-kill-intent",
          );
        });
      });
  });

  it("terminalizes a legacy unowned kill without touching the current child session", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness(runtime);
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "legacy killed",
      sessionId: "session-id",
    };

    await sweeper.sweepOnce();

    expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionLifecycleQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        suppressSessionEffects: true,
      }),
      "sweeper-retired-kill-intent",
    );
  });

  it.each(["same run id", "newer generation", "session revision", "existing successor"] as const)(
    "fences a durable kill when a %s replaces its owner",
    async (change) => {
      const entry = run();
      entry.killIntent = {
        requestedAt: Date.now(),
        reason: "killed",
        sessionId: "session-id",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionLifecycleRevision: "session-revision",
      };
      const runs = new Map([[entry.runId, entry]]);
      const addSuccessor = () => {
        const newer = {
          ...run(),
          runId: "newer-kill-run",
          generation: (entry.generation ?? 0) + 1,
          createdAt: entry.createdAt + 1,
        };
        runs.set(newer.runId, newer);
      };
      if (change === "existing successor") {
        entry.killIntent.lifecycleGeneration = undefined;
        entry.killIntent.sessionLifecycleRevision = undefined;
        addSuccessor();
      }
      const runtime = createDeferred<typeof import("./subagent-control.runtime.js")>();
      const loadKillRuntime = vi.fn(() => runtime.promise);
      const completeSubagentRunWithRecovery = vi.fn();
      const retireSupersededRun = vi.fn();
      const pending = reconcileDurableSubagentKillIntent({
        runId: entry.runId,
        entry,
        runs,
        getRunsForChildSession: childRuns(runs),
        loadKillRuntime,
        completeSubagentRunWithRecovery,
        retireSupersededRun,
        warn: vi.fn(),
      });

      try {
        if (change === "existing successor") {
          expect(loadKillRuntime).not.toHaveBeenCalled();
        } else {
          expect(loadKillRuntime).toHaveBeenCalledOnce();
          if (change === "same run id") {
            runs.set(entry.runId, run());
          } else if (change === "newer generation") {
            addSuccessor();
          } else {
            killSessionEntry.current = {
              sessionId: "session-id",
              lifecycleRevision: "replacement-revision",
              updatedAt: Date.now(),
            };
          }
        }
      } finally {
        runtime.resolve(killRuntime);
        await pending;
      }

      await expect(pending).resolves.toBe(
        change === "session revision" || change === "existing successor",
      );
      expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
      expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(killRuntime.clearSessionLifecycleQueues).not.toHaveBeenCalled();
      if (change === "session revision") {
        expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: entry.runId,
            expectedEntry: entry,
            suppressSessionEffects: true,
          }),
          "sweeper-retired-kill-intent",
        );
      } else {
        expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
      }
      if (change === "existing successor") {
        expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
      } else {
        expect(retireSupersededRun).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["suppressed recovery", "session replacement"] as const)(
    "archives a stale row without touching its successor after %s",
    async (change) => {
      const runtime = { current: {} as GatewayRecoveryRuntime };
      const archived = archivedRun({ generation: 1 });
      if (change === "suppressed recovery") {
        archived.execution.suppressSessionEffects = true;
        archived.execution.outcome = { status: "error", error: "retired Gateway lifecycle" };
        archived.endedReason = "subagent-error";
      }
      const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } = createHarness(
        runtime,
        archived,
      );
      const successor =
        change === "session replacement"
          ? createSubagentRunRecord({
              runId: "successor-run",
              childSessionKey: entry.childSessionKey,
              requesterSessionKey: entry.requesterSessionKey,
              requesterDisplayKey: entry.requesterDisplayKey,
              task: "current successor",
              cleanup: "keep",
              generation: 2,
              createdAt: Date.now(),
              startedAt: Date.now(),
            })
          : undefined;
      if (successor) {
        runs.set(successor.runId, successor);
        getAgentRunContext.mockImplementation((runId: string) =>
          runId === successor.runId ? {} : undefined,
        );
      }
      callGateway.mockImplementation(async (request) => {
        if (request.method !== "sessions.delete") {
          return {};
        }
        killSessionEntry.current = {
          sessionId: "successor-session",
          lifecycleRevision: "successor-revision",
          updatedAt: Date.now(),
        };
        throw Object.assign(new Error("session changed"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: { reason: "session-changed" },
        });
      });

      await sweeper.sweepOnce();

      if (change === "suppressed recovery") {
        expect(callGateway).not.toHaveBeenCalled();
      } else {
        expect(callGateway).toHaveBeenCalledWith({
          method: "sessions.delete",
          params: {
            key: entry.childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
            expectedSessionId: "session-id",
            expectedLifecycleRevision: "session-revision",
          },
          timeoutMs: 10_000,
          assertDispatchCurrent: expect.any(Function),
        });
      }
      expect(runs.has(entry.runId)).toBe(false);
      if (successor) {
        expect(runs.get(successor.runId)).toBe(successor);
      }
      expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    },
  );

  it("reports an admitted registry sweep failure even when restart drain has started", async () => {
    recoverRow.mockImplementationOnce(async () => {
      markGatewayRestartDraining();
      throw new Error("unexpected recovery failure");
    });
    const { sweeper, warn } = createHarness({});

    sweeper.schedule({ delayMs: 1 });
    await vi.advanceTimersByTimeAsync(1);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "subagent run sweep failed: unexpected recovery failure",
    );
  });
});

describe("superseded subagent retirement", () => {
  it.each([
    { refused: false, retireSuccessor: false },
    { refused: true, retireSuccessor: false },
    { refused: false, retireSuccessor: true },
  ])(
    "publishes retirement after durable deletion (refused: $refused, successor retires during cleanup: $retireSuccessor)",
    async ({ refused, retireSuccessor }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const entry = run();
        if (retireSuccessor) {
          entry.execution.transcriptTarget = {
            agentId: "main",
            sessionId: "retired-transcript",
            sessionKey: "agent:main:internal-session-effects:retired",
            storePath: state.sessionsDir("main"),
          };
        }
        const cleanupEntered = createDeferred();
        const releaseCleanup = createDeferred();
        if (retireSuccessor) {
          removeInternalSessionEffectsSession.mockImplementationOnce(async () => {
            cleanupEntered.resolve();
            await releaseCleanup.promise;
          });
        }
        const successor = { ...run(), runId: "successor", generation: (entry.generation ?? 0) + 1 };
        const runs = new Map<string, SubagentRunRecord>();
        await mutateSubagentRuns(
          [entry.runId, successor.runId],
          () => ({
            value: undefined,
            postimages: new Map([
              [entry.runId, entry],
              [successor.runId, successor],
            ]),
          }),
          { runs },
        );
        const clearPendingLifecycleError = vi.fn();
        const execute = stateWorker.runOpenClawStateWorkerOperation;
        const worker = vi
          .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
          .mockImplementation((owner, operation, options) =>
            execute(
              owner,
              (scope) =>
                operation({
                  execute: async (command, executeOptions) => {
                    if (
                      refused &&
                      command.type === "subagents.persistChanges" &&
                      (command.input as SubagentRegistryWrite).deleteRunIds.includes(entry.runId)
                    ) {
                      throw new Error("registry deletion failed");
                    }
                    return scope.execute(command, executeOptions);
                  },
                }),
              options,
            ),
          );
        try {
          const deletion = retireSupersededSubagentRun({
            runId: entry.runId,
            entry,
            runs,
            clearPendingLifecycleError,
          });
          if (retireSuccessor) {
            try {
              await cleanupEntered.promise;
              await mutateSubagentRuns(
                [successor.runId],
                () => ({
                  value: undefined,
                  postimages: new Map([[successor.runId, null]]),
                }),
                { runs },
              );
            } finally {
              releaseCleanup.resolve();
            }
          }
          if (refused) {
            await expect(deletion).rejects.toThrow("registry deletion failed");
          } else {
            await deletion;
          }
          const persisted = await executeExistingOpenClawStateRead(
            { env: state.env },
            {
              type: "subagents.runs",
              scope: { kind: "ids", runIds: [entry.runId, successor.runId] },
            },
          );
          if (!persisted?.ok || persisted.type !== "subagents.runs" || persisted.projection) {
            throw new Error("Retirement fixture could not read durable rows");
          }
          expect(runs.has(entry.runId)).toBe(refused);
          expect(persisted.runs.has(entry.runId)).toBe(refused);
          expect(persisted.runs.has(successor.runId)).toBe(!retireSuccessor);
          if (refused) {
            expect(clearPendingLifecycleError).not.toHaveBeenCalled();
          } else {
            expect(clearPendingLifecycleError).toHaveBeenCalledExactlyOnceWith(entry.runId);
          }
        } finally {
          worker.mockRestore();
        }
      });
    },
  );
});
