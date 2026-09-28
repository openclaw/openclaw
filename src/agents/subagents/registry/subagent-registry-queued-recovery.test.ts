import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-state.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";

const fixture = vi.hoisted(() => ({
  sessionId: "retained-collector-session",
  lifecycleRevision: "retained-collector-lifecycle",
}));
vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: vi.fn(async () => null),
  findTranscriptEvent: () => {
    throw new Error("Unexpected transcript lookup in queued registration recovery");
  },
}));
vi.mock("../../../gateway/call.js", () => ({ callGateway: vi.fn() }));
vi.mock("./subagent-registry-state.js", { spy: true });
vi.mock("./subagent-session-reconciliation.js", () => ({
  loadSubagentSessionEntry: () => ({
    sessionId: fixture.sessionId,
    lifecycleRevision: fixture.lifecycleRevision,
  }),
}));

beforeEach(() => {
  vi.mocked(patchSessionEntryCore).mockClear();
  subagentRuns.clear();
});
afterEach(() => {
  vi.mocked(restoreSubagentRunsFromDisk).mockReset();
  subagentRuns.clear();
});

function createRegistrationFixture() {
  const stored = new Map<string, SubagentRunRecord>();
  const persist = (...runIds: string[]) => {
    for (const runId of runIds.length > 0 ? runIds : subagentRuns.keys()) {
      const entry = subagentRuns.get(runId);
      if (entry) {
        stored.set(runId, structuredClone(entry));
      } else {
        stored.delete(runId);
      }
    }
  };
  const options: SubagentManagerOptions = {
    runs: subagentRuns,
    getRunsForChildSession: (key) =>
      [...subagentRuns.values()].filter((run) => run.childSessionKey === key),
    resumedRuns: new Set(),
    persist,
    persistOrThrow: persist,
    persistAsyncOrThrow: async (_context, publication, ...runIds) => {
      publication.assertCurrent();
      if (stored.size > 0) {
        throw new SubagentRegistryWriteError("not-committed", new Error("descriptor refused"));
      }
      persist(...runIds);
      await Promise.resolve();
      publication.onCommitted?.();
    },
    callGateway: async () => {
      throw new Error("Unexpected registration Gateway call");
    },
    getRuntimeConfig: () => ({}),
    ensureListener: () => {},
    startSweeper: () => {},
    stopSweeper: () => {},
    resumeSubagentRun: () => {},
    clearPendingLifecycleError: () => {},
    clearPendingLifecycleTimeout: () => {},
    resolveSubagentWaitTimeoutMs: () => 100,
    scheduleSweep: () => {},
    resolveSubagentSessionCompletion: () => null,
    resolveSubagentSessionStartedAt: () => undefined,
    notifyContextEngineSubagentEnded: async () => {},
    completeCleanupBookkeeping: () => {},
    completeSubagentRun: async () => {},
  };
  const manager = createSubagentRunManager(options);
  return { stored, persist, options, manager };
}

it.each(["restart", "restart with newer sibling", "confirmed Stop"] as const)(
  "reconciles a retained descriptorless registration through %s",
  async (recovery) => {
    const newerSibling = recovery === "restart with newer sibling";
    const { stored, persist, manager } = createRegistrationFixture();
    let ownership: SubagentRegistrationScope | undefined;
    const runId = "retained-registration";
    const childSessionKey = "agent:main:subagent:retained-registration";
    const sql = observeMainThreadSql();
    const transport = vi.mocked(callGateway).mockReset().mockResolvedValue({});
    const cleanupResources = vi.fn(async () => true);
    const cleaned = vi.fn();
    const resume = vi.fn();
    const startQueued = vi.fn(() => true);
    vi.mocked(restoreSubagentRunsFromDisk).mockImplementation(({ runs }) => {
      for (const [id, entry] of stored) {
        runs.set(id, structuredClone(entry));
      }
      return stored.size;
    });
    const restorer = createSubagentRegistryRestorer({
      runs: subagentRuns,
      getGatewayContextResolver: () => undefined,
      bindGatewayOwners: () => true,
      persist,
      persistOrThrow: persist,
      settleRequesterTurn: () => false,
      ensureListener: () => {},
      startSweeper: () => {},
      scheduleSweep: () => {},
      resumeRun: resume,
      listSwarmRunsForGroup: () => [...subagentRuns.values()],
      startQueuedSubagentRun: startQueued,
      terminateAcceptedRestoredCollectorRun: async () => {},
      cleanupCollectorLaunchResources: cleanupResources,
      settleFailedQueuedSubagentLaunch: manager.settleFailedQueuedSubagentLaunch,
      completeCollectorLaunchCleanup: cleaned,
      warn: () => {},
    });
    try {
      await expect(
        manager.registerSubagentRun(
          {
            runId,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            requesterAgentId: "main",
            task: "retained registration recovery",
            cleanup: "keep",
            collect: true,
            groupId: "retained-group",
            queued: true,
            queuedLaunch: {
              request: { sessionKey: childSessionKey },
              timeoutMs: 100,
              schedulerGroupKey: "retained-group",
              maxConcurrent: 1,
            },
          },
          {
            retainOwnership: (scope) => {
              ownership = scope;
            },
          },
        ),
      ).rejects.toMatchObject({ outcome: "not-committed" });
      expect(stored.get(runId)?.queuedLaunch).toBeUndefined();
      expect(stored.get(runId)?.execution.status).toBe("queued");
      expect(expectDefined(ownership, "registration scope").canCleanupSession()).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(cleanupResources).not.toHaveBeenCalled();

      if (recovery === "confirmed Stop") {
        expect(manager.markSubagentRunTerminated({ runId })).toBe(1);
        const stopped = expectDefined(subagentRuns.get(runId), "stopped original run");
        const stoppedExecution = stopped.execution;
        expect(stored.get(runId)?.killReconciliation).toBeDefined();
        await expect(
          expectDefined(ownership, "registration scope").settleFailedLaunch("later callback"),
        ).resolves.toBeUndefined();
        expect(stopped.execution).toBe(stoppedExecution);
        expect(expectDefined(ownership, "registration scope").canCleanupSession()).toBe(false);
        expect(patchSessionEntryCore).toHaveBeenCalled();
        return;
      }
      if (newerSibling) {
        const original = expectDefined(stored.get(runId), "retained original intent");
        const successor: SubagentRunRecord = {
          ...structuredClone(original),
          runId: "recovered-successor",
          generation: (original.generation ?? 0) + 1,
          execution: {
            status: "running",
            startedAt: Date.now(),
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        };
        stored.set(successor.runId, successor);
        subagentRuns.set(successor.runId, successor);
      }
      subagentRuns.clear();
      restorer.restoreOnce();
      restorer.activate();
      await vi.waitFor(() => expect(stored.get(runId)?.execution.status).toBe("terminal"));
      expect(stored.get(runId)).toMatchObject({
        execution: { status: "terminal", lifecycleGeneration: getAgentEventLifecycleGeneration() },
        collectorCompletion: { status: "failed" },
      });
      if (newerSibling) {
        expect(transport).not.toHaveBeenCalled();
        expect(cleanupResources).not.toHaveBeenCalled();
        expect(stored.get(runId)?.execution.suppressSessionEffects).toBe(true);
        expect(resume).toHaveBeenCalledExactlyOnceWith("recovered-successor");
      } else {
        expect(transport).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            method: "sessions.delete",
            params: expect.objectContaining({
              key: childSessionKey,
              expectedSessionId: fixture.sessionId,
              expectedLifecycleRevision: fixture.lifecycleRevision,
            }),
          }),
        );
        expect(cleanupResources).toHaveBeenCalledOnce();
        expect(cleaned).toHaveBeenCalledExactlyOnceWith(runId);
        expect(resume).not.toHaveBeenCalled();
      }
      expect(startQueued).not.toHaveBeenCalled();
      sql.expectIdle();
    } finally {
      try {
        restorer.reset();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    }
  },
);

it("settles an acknowledged queued launch failure through its captured native registry owner", async () => {
  const { stored, persist, options, manager } = createRegistrationFixture();
  options.persistAsyncOrThrow = async (_context, publication, ...runIds) => {
    publication.assertCurrent();
    persist(...runIds);
    await Promise.resolve();
    publication.onCommitted?.();
  };
  const runId = "acknowledged-launch-failure";
  const childSessionKey = "agent:main:subagent:acknowledged-launch-failure";
  let scope: SubagentRegistrationScope | undefined;
  await manager.registerSubagentRun(
    {
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      task: "registered work awaiting its FIFO slot",
      cleanup: "keep",
      collect: true,
      groupId: "acknowledged-launch-group",
      queued: true,
      queuedLaunch: {
        request: { sessionKey: childSessionKey },
        timeoutMs: 100,
        schedulerGroupKey: "acknowledged-launch-group",
        maxConcurrent: 1,
      },
    },
    {
      retainOwnership: (value) => {
        scope = value;
      },
    },
  );
  const original = expectDefined(subagentRuns.get(runId), "acknowledged native run");
  expect(original.execution.status).toBe("queued");
  expect(stored.get(runId)?.queuedLaunch).toBeDefined();
  await expectDefined(scope, "retained registration").settleFailedLaunch("launch refused");
  const terminal = expectDefined(stored.get(runId), "native run after settlement");
  expect(terminal).toMatchObject({
    execution: { status: "terminal", outcome: { status: "error", error: "launch refused" } },
  });
  expect(stored.get(runId)).toMatchObject({
    execution: { status: "terminal", endedAt: terminal.execution.endedAt },
    collectorCompletion: { status: "failed" },
  });
  expect(stored.get(runId)?.queuedLaunch).toBeUndefined();
});
