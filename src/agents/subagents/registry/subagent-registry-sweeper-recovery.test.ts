import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { reconcileDurableSubagentKillIntent } from "./subagent-registry-sweep-kill.js";
import { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";
import {
  createSubagentSweeperRun as run,
  createSubagentSweeperChildLookup as childRuns,
  createArchivedSubagentSweeperRun as archivedRun,
  createSubagentSweeperHarness as createHarness,
} from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

const recoverRow = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn<(_runId: string) => unknown>(() => undefined));
const removeInternalSessionEffectsSession = vi.hoisted(() => vi.fn(async () => {}));
const detachedTaskRuntime = vi.hoisted(() => ({
  finalizeTaskRunByRunId: vi.fn(() => [] as unknown[]),
  findDetachedTaskRun: vi.fn(() => undefined as unknown),
}));
const killRuntime = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn(() => false),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
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
vi.mock("../../../tasks/detached-task-runtime.js", () => detachedTaskRuntime);
vi.mock("../../../tasks/detached-task-runtime.async.js", () => ({
  finalizeTaskRunByRunIdAsync: detachedTaskRuntime.finalizeTaskRunByRunId,
}));
vi.mock("./subagent-control.runtime.js", () => killRuntime);
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
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    killRuntime.abortEmbeddedAgentRun.mockReset().mockReturnValue(false);
    killRuntime.isEmbeddedAgentRunActive.mockReset().mockReturnValue(false);
    killRuntime.clearSessionQueues.mockReset().mockReturnValue({
      followupCleared: 0,
      laneCleared: 0,
      keys: [],
    });
    killSessionEntry.current = {
      sessionId: "session-id",
      lifecycleRevision: "session-revision",
      updatedAt: Date.now(),
    };
    detachedTaskRuntime.finalizeTaskRunByRunId.mockReset().mockReturnValue([]);
    detachedTaskRuntime.findDetachedTaskRun.mockReset().mockReturnValue(undefined);
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
            { ...sessionEntry, sessionId: "sibling-session", status: "running" },
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
            sweeper.reset();
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
      await vi.waitFor(() => expect(recoverRow).toHaveBeenCalledOnce());
      if (change === "lifecycle") {
        rotateAgentEventLifecycleGeneration();
      } else {
        runtime.current = {} as GatewayRecoveryRuntime;
      }
      classification.resolve({ status: "terminal", error: "Gateway restart" });
      await pending;
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
              sweeper.reset();
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
    await vi.waitFor(() => expect(finalizeInterruptedSubagentRun).toHaveBeenCalledOnce());
    const newer = run();
    newer.runId = "newer-recovery-run";
    newer.generation = (entry.generation ?? 0) + 1;
    runs.set(newer.runId, newer);
    finalization.resolve(0);
    await pending;
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
    await vi.advanceTimersByTimeAsync(1_000);

    expect(recoverRow).toHaveBeenCalledTimes(3);
    expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
  });

  it("never terminalizes a deferred live owner", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "deferred" });
    const { finalizeInterruptedSubagentRun, sweeper } = createHarness(runtime);

    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(recoverRow.mock.calls.length).toBeGreaterThan(4);
    expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
  });

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
    expect(killRuntime.clearSessionQueues).toHaveBeenCalledWith([
      entry.childSessionKey,
      "session-id",
    ]);
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
    expect(killRuntime.clearSessionQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        suppressSessionEffects: true,
      }),
      "sweeper-retired-kill-intent",
    );
  });

  it.each([
    [
      "same run id",
      (runs: Map<string, SubagentRunRecord>, entry: SubagentRunRecord) =>
        runs.set(entry.runId, run()),
    ],
    [
      "newer generation",
      (runs: Map<string, SubagentRunRecord>, entry: SubagentRunRecord) => {
        const newer = run();
        newer.runId = "newer-kill-run";
        newer.generation = (entry.generation ?? 0) + 1;
        runs.set(newer.runId, newer);
      },
    ],
  ])("does not apply a durable kill after %s wins during runtime loading", async (_name, win) => {
    const entry = run();
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionLifecycleRevision: "session-revision",
    };
    const runs = new Map([[entry.runId, entry]]);
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

    await vi.waitFor(() => expect(loadKillRuntime).toHaveBeenCalledOnce());
    win(runs, entry);
    runtime.resolve(killRuntime as never);

    await expect(pending).resolves.toBe(false);
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
    expect(retireSupersededRun).not.toHaveBeenCalled();
  });

  it("does not apply a durable kill after the same session id resets to a new revision", async () => {
    const entry = run();
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionLifecycleRevision: "session-revision",
    };
    const runs = new Map([[entry.runId, entry]]);
    let releaseRuntime!: () => void;
    const loadKillRuntime = vi.fn(
      () =>
        new Promise<typeof import("./subagent-control.runtime.js")>((resolve) => {
          releaseRuntime = () =>
            resolve(killRuntime as unknown as typeof import("./subagent-control.runtime.js"));
        }),
    );
    const completeSubagentRunWithRecovery = vi.fn();

    const pending = reconcileDurableSubagentKillIntent({
      runId: entry.runId,
      entry,
      runs,
      getRunsForChildSession: childRuns(runs),
      loadKillRuntime,
      completeSubagentRunWithRecovery,
      retireSupersededRun: vi.fn(),
      warn: vi.fn(),
    });
    await vi.waitFor(() => expect(loadKillRuntime).toHaveBeenCalledOnce());
    killSessionEntry.current = {
      sessionId: "session-id",
      lifecycleRevision: "replacement-revision",
      updatedAt: Date.now(),
    };
    releaseRuntime();

    await expect(pending).resolves.toBe(true);
    expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        suppressSessionEffects: true,
      }),
      "sweeper-retired-kill-intent",
    );
  });

  it("does not apply an older durable kill when a newer child generation exists", async () => {
    const entry = run();
    entry.generation = 1;
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
    };
    const newer = createSubagentRunRecord({
      runId: "newer-run",
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: "newer generation",
      cleanup: "keep",
      generation: 2,
      createdAt: entry.createdAt + 1,
      startedAt: entry.execution.startedAt ? entry.execution.startedAt + 1 : Date.now(),
    });
    const runs = new Map([
      [entry.runId, entry],
      [newer.runId, newer],
    ]);
    const completeSubagentRunWithRecovery = vi.fn();
    const retireSupersededRun = vi.fn(async () => {});
    detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
      lookup: "available",
      task: {
        runId: entry.runId,
        runtime: "subagent",
        childSessionKey: entry.childSessionKey,
        status: "running",
        createdAt: entry.createdAt,
      },
    });
    detachedTaskRuntime.finalizeTaskRunByRunId.mockReturnValue([
      {
        runId: entry.runId,
        runtime: "subagent",
        childSessionKey: entry.childSessionKey,
        status: "cancelled",
        createdAt: entry.createdAt,
        endedAt: entry.killIntent.requestedAt,
      },
    ]);

    await expect(
      reconcileDurableSubagentKillIntent({
        runId: entry.runId,
        entry,
        runs,
        getRunsForChildSession: childRuns(runs),
        loadKillRuntime: async () =>
          killRuntime as unknown as typeof import("./subagent-control.runtime.js"),
        completeSubagentRunWithRecovery,
        retireSupersededRun,
        warn: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
    expect(detachedTaskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        status: "cancelled",
        suppressDelivery: true,
      }),
      expect.any(Function),
    );
    expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
  });

  it("retires a superseded kill when its detached task runtime is opaque", async () => {
    const entry = run();
    entry.generation = 1;
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
    };
    const newer = createSubagentRunRecord({
      runId: "newer-opaque-run",
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: "newer generation",
      cleanup: "keep",
      generation: 2,
      createdAt: entry.createdAt + 1,
      startedAt: entry.execution.startedAt ? entry.execution.startedAt + 1 : Date.now(),
    });
    const runs = new Map([
      [entry.runId, entry],
      [newer.runId, newer],
    ]);
    const retireSupersededRun = vi.fn(async () => {});
    detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "unavailable" });

    await expect(
      reconcileDurableSubagentKillIntent({
        runId: entry.runId,
        entry,
        runs,
        getRunsForChildSession: childRuns(runs),
        loadKillRuntime: async () =>
          killRuntime as unknown as typeof import("./subagent-control.runtime.js"),
        completeSubagentRunWithRecovery: vi.fn(),
        retireSupersededRun,
        warn: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(detachedTaskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        status: "cancelled",
        suppressDelivery: true,
      }),
      expect.any(Function),
    );
    expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
  });

  it("discards suspended retired recovery delivery without touching its child session", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, completeCleanupBookkeeping, emitSubagentEndedHookForRun, sweeper } =
      createHarness(runtime);
    entry.execution = {
      status: "terminal",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 55_000,
      outcome: { status: "error", error: "retired Gateway lifecycle" },
      suppressSessionEffects: true,
    };
    entry.endedReason = "subagent-error";
    entry.expectsCompletionMessage = true;
    entry.delivery = {
      status: "suspended",
      suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
      suspendedReason: "expiry",
      payload: {
        requesterSessionKey: entry.requesterSessionKey,
        requesterDisplayKey: entry.requesterDisplayKey,
        childSessionKey: entry.childSessionKey,
        childRunId: entry.runId,
        task: entry.task,
      },
    };

    await sweeper.sweepOnce();

    expect(removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(completeCleanupBookkeeping).toHaveBeenCalledWith(
      expect.objectContaining({ runId: entry.runId, entry }),
    );
  });

  it("archives a retired recovery row without deleting its newer child session", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } =
      createHarness(runtime);
    entry.cleanup = "delete";
    entry.archiveAtMs = Date.now() - 1;
    entry.execution = {
      status: "terminal",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 55_000,
      outcome: { status: "error", error: "retired Gateway lifecycle" },
      suppressSessionEffects: true,
    };
    entry.endedReason = "subagent-error";

    await sweeper.sweepOnce();

    expect(callGateway).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retires an archived stale owner when guarded deletion sees a successor", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } =
      createHarness(runtime);
    entry.cleanup = "delete";
    entry.archiveAtMs = Date.now() - 1;
    entry.execution = {
      status: "terminal",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 55_000,
      outcome: { status: "ok" },
    };
    const successor = createSubagentRunRecord({
      runId: "successor-run",
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: "current successor",
      cleanup: "keep",
      generation: 2,
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    entry.generation = 1;
    runs.set(successor.runId, successor);
    getAgentRunContext.mockImplementation((runId: string) =>
      runId === successor.runId ? {} : undefined,
    );
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
    expect(runs.has(entry.runId)).toBe(false);
    expect(runs.get(successor.runId)).toBe(successor);
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
  });

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

  it("releases the owner lane after an unexpected pass failure", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow
      .mockRejectedValueOnce(new Error("unexpected recovery failure"))
      .mockResolvedValue({ status: "ignored" });
    const { sweeper, warn } = createHarness(runtime);

    await sweeper.runTick();
    await sweeper.runTick();

    expect(recoverRow).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("subagent run sweep failed: unexpected recovery failure");
  });
});

describe("superseded subagent retirement", () => {
  it("restores the registry row when durable deletion fails", async () => {
    const entry = run();
    const runs = new Map([[entry.runId, entry]]);
    const clearPendingLifecycleError = vi.fn();

    await expect(
      retireSupersededSubagentRun({
        runId: entry.runId,
        entry,
        runs,
        clearPendingLifecycleError,
        persistOrThrow: () => {
          throw new Error("registry deletion failed");
        },
      }),
    ).rejects.toThrow("registry deletion failed");

    expect(runs.get(entry.runId)).toBe(entry);
    expect(clearPendingLifecycleError).not.toHaveBeenCalled();
  });

  it("clears lifecycle errors only after durable deletion succeeds", async () => {
    const entry = run();
    const runs = new Map([[entry.runId, entry]]);
    const clearPendingLifecycleError = vi.fn();
    const persistOrThrow = vi.fn();

    await retireSupersededSubagentRun({
      runId: entry.runId,
      entry,
      runs,
      clearPendingLifecycleError,
      persistOrThrow,
    });

    expect(runs.has(entry.runId)).toBe(false);
    expect(persistOrThrow).toHaveBeenCalledWith(entry.runId);
    expect(clearPendingLifecycleError).toHaveBeenCalledWith(entry.runId);
  });
});
