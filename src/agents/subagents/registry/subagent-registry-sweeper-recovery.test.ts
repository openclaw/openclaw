import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../../../config/sessions/session-accessor.js";
import { createGatewayRequestContext } from "../../../gateway/server-request-context.js";
import { makeContextParams } from "../../../gateway/server-request-context.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "./subagent-control-native.test-support.js";
import { prepareSubagentKillSession } from "./subagent-control-session.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import { mutateCleanup } from "./subagent-registry-sweep-cleanup.js";
import { reconcileDurableSubagentKillIntent } from "./subagent-registry-sweep-kill.js";
import { registerSubagentSweepKillCustodyTests } from "./subagent-registry-sweeper-kill-custody.test-support.js";
import { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";
import {
  createSweepGate,
  persistRuns,
  readPersistedRuns,
  registerSubagentSweepRetainedAuthorityTests,
  withRealSessionReads,
  withSweeperSessionState,
} from "./subagent-registry-sweeper-session-read.test-support.js";
import {
  createArchivedSubagentSweeperRun as archivedRun,
  createSubagentSweeperHarness as createHarness,
  createSubagentSweeperRun as run,
} from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

const getAgentRunContext = vi.hoisted(() => vi.fn<(_runId: string) => unknown>(() => undefined));
const removeInternalSessionEffectsSession = vi.hoisted(() => vi.fn(async () => {}));
const killSessionEntry = vi.hoisted(() => ({
  current: undefined as
    | { sessionId: string; lifecycleRevision?: string; updatedAt: number }
    | undefined,
}));

const makeSessionEntry = (sessionId: string, lifecycleRevision: string) => ({
  sessionId,
  lifecycleRevision,
  updatedAt: Date.now(),
});
const reserveFollowup = (target: ReturnType<typeof captureSessionTarget>) =>
  reserveSessionControllerSource(target.sessionKey, { target, policy: { mode: "followup" } });
const sessionChangedError = () =>
  Object.assign(new Error("session changed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "session-changed" },
  });
vi.mock("../../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/agent-run-registry.js")>()),
  getAgentRunContext,
}));
// mock-isolation: Observe session-effect cleanup without touching live session state.
vi.mock("../../internal-session-effects.js", () => ({ removeInternalSessionEffectsSession }));
vi.mock("./subagent-control-session.js", { spy: true });
vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-session-reconciliation.js")>();
  return {
    ...actual,
    loadSubagentSessionEntry: vi.fn(async () => killSessionEntry.current),
  };
});

afterAll(() => clearRuntimeConfigSnapshot());

describe("subagent registry cleanup scheduling", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({ session: { store: "/synthetic-kill/sessions.sqlite" } });
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    vi.mocked(loadSubagentSessionEntry)
      .mockReset()
      .mockImplementation(async () => killSessionEntry.current);
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
    killSessionEntry.current = makeSessionEntry("session-id", "session-revision");
    removeInternalSessionEffectsSession.mockReset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  registerSubagentSweepRetainedAuthorityTests(killSessionEntry);

  it("isolates cleanup changes without copying the immutable run payload", async () => {
    const { entry, runs } = createHarness(archivedRun());
    const execution = { ...entry.execution };
    using clone = vi.spyOn(globalThis, "structuredClone");

    const updated = await mutateCleanup(
      runs,
      entry,
      () => true,
      (draft) => {
        draft.execution.suppressSessionEffects = true;
        draft.contextEngineCleanupCompletedAt = 123;
      },
    );

    expect(entry.execution).toEqual(execution);
    expect(entry.contextEngineCleanupCompletedAt).toBeUndefined();
    expect(updated).toMatchObject({
      execution: { suppressSessionEffects: true },
      contextEngineCleanupCompletedAt: 123,
    });
    expect(runs.get(entry.runId)).toEqual(updated);
    expect(clone.mock.calls.some(([value]) => value === entry)).toBe(false);
  });

  it.each(["terminal", "running"] as const)(
    "only gives ended %s children requester-wake priority over suspended delivery cleanup",
    async (executionStatus) => {
      const { entry, completeCleanupBookkeeping, resumeRequesterSettleWake, sweeper } =
        createHarness();
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

      if (executionStatus === "terminal") {
        expect(completeCleanupBookkeeping).not.toHaveBeenCalled();
        expect(resumeRequesterSettleWake).toHaveBeenCalledWith(entry.runId, entry);
      } else {
        expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["replacement", "publication", "lifecycle", "Gateway owner"] as const)(
    "refuses cleanup when its %s changes before deletion dispatch",
    async (change) => {
      const { entry, runs, callGateway, sweeper } = createHarness(archivedRun());
      const gateway = Object.assign(createGatewayRequestContext(makeContextParams()), {
        localEmbedded: true,
      });
      gateway.resolveGatewayContext = () => gateway;
      bindGatewayContextResolver(runs, gateway.resolveGatewayContext);
      const gate = createSweepGate();
      const deleteSession = vi.fn();
      callGateway.mockImplementationOnce(async (request) => {
        await gate.wait();
        request.assertDispatchCurrent();
        deleteSession();
        return {};
      });
      await gate.check(sweeper, async (finish) => {
        let retained = entry;
        if (change === "replacement" || change === "publication") {
          retained = { ...entry, label: "current row" };
          if (change === "publication") {
            copySubagentRunRuntimeOwner(entry, retained);
          }
          runs.set(entry.runId, retained);
        } else if (change === "lifecycle") {
          rotateAgentEventLifecycleGeneration();
        } else {
          bindGatewayContextResolver(runs, () => undefined);
        }
        expect(await finish()).toBeUndefined();
        expect(deleteSession).not.toHaveBeenCalled();
        expect(runs.get(entry.runId)).toBe(retained);
      });
    },
  );

  it.each(["ordinary", "collector group", "collector launch"])(
    "preserves a reset sibling during an earlier await in %s cleanup",
    async (kind) => {
      await withRealSessionReads(async (state) => {
        const { entry, runs, callGateway, sweeper } = createHarness(archivedRun());
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
          child.childSessionIdentity = {
            sessionId: child.runId,
            lifecycleRevision: "original-revision",
          };
          replaceSessionEntrySync(
            { sessionKey: child.childSessionKey, env: state.env },
            makeSessionEntry(child.runId, "original-revision"),
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
            throw sessionChangedError();
          }
          return deleted;
        });
        try {
          await sweeper.sweepOnce();
          expect(loadSessionEntryReadOnly({ sessionKey: entry.childSessionKey })).toBeUndefined();
          expect(loadSessionEntryReadOnly({ sessionKey: sibling.childSessionKey })).toMatchObject({
            sessionId: sibling.runId,
            lifecycleRevision: "reset-revision",
          });
        } finally {
          await sweeper.reset();
        }
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
      const { entry, runs, callGateway, sweeper } = createHarness(archivedRun());
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

  it.each([false, true])(
    "finishes admitted cleanup and defers the remaining sweep during shutdown (collector=%s)",
    async (collector) => {
      const retained = collector
        ? { collect: true, groupId: "group", collectorCompletion: { status: "done" as const } }
        : {};
      const { entry, runs, callGateway, sweeper } = createHarness(archivedRun(retained));
      const sibling = archivedRun({
        ...retained,
        runId: "sibling-run",
        childSessionKey: "agent:main:subagent:sibling",
      });
      runs.set(sibling.runId, sibling);
      const deletion = createEnteredGate();
      callGateway.mockImplementationOnce(deletion.wait);
      let settled = false;
      const sweep = sweeper.runTick().then(() => {
        settled = true;
      });
      try {
        await deletion.entered;
        markGatewayRestartDraining("stop (SIGTERM)");
        expect(settled).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      } finally {
        deletion.release();
        await sweep;
      }

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect([...runs.keys()]).toEqual(collector ? [entry.runId, sibling.runId] : [sibling.runId]);

      resetGatewayWorkAdmission();
      await sweeper.runTick();
      expect(runs.size).toBe(0);
      expect(callGateway).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ key: sibling.childSessionKey }),
        }),
      );
    },
  );

  it("does not terminalize a durable kill intent while a live run is not abortable", async () => {
    const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness();
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionLifecycleRevision: "session-revision",
    };
    getAgentRunContext.mockReturnValue({});
    const target = captureSessionTarget({
      storeScope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: "main",
      }),
      sessionKey: entry.childSessionKey,
      incarnation: "session-id",
    });
    const abort = vi.fn();
    const native = createEmbeddedRunHandle({ runId: entry.runId, isAbortable: false, abort });
    attachActiveEmbeddedRun("session-id", native, target.sessionKey, target.storeScope);
    const source = reserveFollowup(target);
    const foreign = reserveFollowup(
      captureSessionTarget({ ...target, incarnation: "prior-incarnation" }),
    );
    onTestFinished(async () => {
      await detachActiveEmbeddedRun("session-id", native, target.sessionKey);
      retireSessionControllerInput(source);
      retireSessionControllerInput(foreign);
      await Promise.all([source.settlement.promise, foreign.settlement.promise]);
    });

    await sweeper.sweepOnce();

    expect(abort).not.toHaveBeenCalled();
    expect(source.abortSignal.aborted).toBe(true);
    expect(foreign.abortSignal.aborted).toBe(false);
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();

    getAgentRunContext.mockReturnValue(undefined);
    await detachActiveEmbeddedRun("session-id", native, target.sessionKey);
    await sweeper.sweepOnce();

    expect(foreign.abortSignal.aborted).toBe(false);
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
        await withSweeperSessionState(async (state) => {
          const { entry, runs, completeSubagentRunWithRecovery } = createHarness();
          entry.childSessionKey = "global";
          entry.childAgentId = "research";
          entry.childSessionIdentity = {
            sessionId: "research-session",
            lifecycleRevision: "research-revision",
          };
          const cfg = getRuntimeConfig();
          const storePath = resolveSessionStorePathCore(cfg.session?.store, {
            agentId: "research",
          });
          replaceSessionEntrySync(
            { agentId: "research", storePath, sessionKey: "global", env: state.env },
            makeSessionEntry("research-session", "research-revision"),
          );
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "global", env: state.env },
            makeSessionEntry("main-session", "main-revision"),
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
          const source = reserveFollowup(
            captureSessionTarget({
              storeScope: storePath,
              sessionKey: "global",
              agentId: "research",
              incarnation: "research-session",
            }),
          );
          const foreignSource = reserveFollowup(
            captureSessionTarget({
              storeScope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
              sessionKey: "global",
              agentId: "main",
              incarnation: "main-session",
            }),
          );
          const sql = observeMainThreadSql();
          try {
            expect(
              await reconcileDurableSubagentKillIntent({
                runId: entry.runId,
                entry,
                runs,
                getRunsForChildSession: getSubagentRunsForChildSession,
                retireObligations: vi.fn(async () => {}),
                completeSubagentRunWithRecovery,
                retireSupersededRun: vi.fn(),
                warn: vi.fn(),
              }),
            ).toBe(true);
            sql.expectIdle();
          } finally {
            sql.restore();
            retireSessionControllerInput(source);
            retireSessionControllerInput(foreignSource);
            await Promise.all([source.settlement.promise, foreignSource.settlement.promise]);
          }
          expect(source.abortSignal.aborted).toBe(true);
          expect(foreignSource.abortSignal.aborted).toBe(false);
          expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
            expect.not.objectContaining({ suppressSessionEffects: true }),
            "sweeper-pending-kill-intent",
          );
        });
      });
  });

  it("terminalizes a legacy unowned kill without touching the current child session", async () => {
    const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness();
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "legacy killed",
      sessionId: "session-id",
    };

    await sweeper.sweepOnce();

    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        suppressSessionEffects: true,
      }),
      "sweeper-retired-kill-intent",
    );
  });

  registerSubagentSweepKillCustodyTests(killSessionEntry);

  it.each(["suppressed effects", "session replacement"] as const)(
    "archives a stale row without touching its successor after %s",
    async (change) => {
      const archived = archivedRun({ generation: 1 });
      if (change === "suppressed effects") {
        archived.execution.suppressSessionEffects = true;
        archived.execution.outcome = { status: "error", error: "retired Gateway lifecycle" };
        archived.endedReason = "subagent-error";
      }
      const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } =
        createHarness(archived);
      const successor =
        change === "session replacement"
          ? createSubagentRunRecord({
              runId: "successor-run",
              childSessionKey: entry.childSessionKey,
              task: "current successor",
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
        killSessionEntry.current = makeSessionEntry("successor-session", "successor-revision");
        throw sessionChangedError();
      });

      await sweeper.sweepOnce();

      if (change === "suppressed effects") {
        expect(callGateway).not.toHaveBeenCalled();
      } else {
        expect(callGateway).toHaveBeenCalledWith({
          method: "sessions.delete",
          params: {
            key: entry.childSessionKey,
            agentId: "main",
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
});

describe("superseded subagent retirement", () => {
  it.each([
    { refused: false, retireSuccessor: false },
    { refused: true, retireSuccessor: false },
    { refused: false, retireSuccessor: true },
  ])(
    "publishes retirement after durable deletion (refused: $refused, successor retires during cleanup: $retireSuccessor)",
    async ({ refused, retireSuccessor }) => {
      await withSweeperSessionState(async (state) => {
        const entry = run();
        if (retireSuccessor) {
          entry.execution.transcriptTarget = {
            agentId: "main",
            sessionId: "retired-transcript",
            sessionKey: "agent:main:internal-session-effects:retired",
            storePath: state.sessionsDir("main"),
          };
        }
        const cleanupGate = createEnteredGate();
        if (retireSuccessor) {
          removeInternalSessionEffectsSession.mockImplementationOnce(cleanupGate.wait);
        }
        const successor = { ...run(), runId: "successor", generation: (entry.generation ?? 0) + 1 };
        const runs = new Map<string, SubagentRunRecord>();
        await persistRuns(runs, [
          [entry.runId, entry],
          [successor.runId, successor],
        ]);
        const clearPendingLifecycleError = vi.fn();
        const worker = probe.command(stateWorker, async (command, executeOptions, scope) => {
          if (
            refused &&
            command.type === "subagents.persistChanges" &&
            (command.input as SubagentRegistryWrite).deleteRunIds.includes(entry.runId)
          ) {
            throw new Error("registry deletion failed");
          }
          return scope.execute(command, executeOptions);
        });
        try {
          const deletion = retireSupersededSubagentRun({
            runId: entry.runId,
            entry,
            runs,
            clearPendingLifecycleError,
          });
          if (retireSuccessor) {
            try {
              await cleanupGate.entered;
              await persistRuns(runs, [[successor.runId, null]]);
            } finally {
              cleanupGate.release();
            }
          }
          if (refused) {
            await expect(deletion).rejects.toThrow("registry deletion failed");
          } else {
            await deletion;
          }
          const persisted = await readPersistedRuns(state.env, [entry.runId, successor.runId]);
          expect(runs.has(entry.runId)).toBe(refused);
          expect(persisted.has(entry.runId)).toBe(refused);
          expect(persisted.has(successor.runId)).toBe(!retireSuccessor);
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
