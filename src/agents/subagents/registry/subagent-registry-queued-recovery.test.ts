import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { callGateway } from "../../../gateway/call.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";

const fixture = vi.hoisted(() => ({
  sessionId: "retained-collector-session",
  lifecycleRevision: "retained-collector-lifecycle",
}));
vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  findTranscriptEvent: () => {
    throw new Error("Unexpected transcript lookup in queued registration recovery");
  },
}));
vi.mock("../../../config/sessions/session-accessor.sqlite-replacement-projection.js", () => ({
  applySessionEntryExactReplacements: vi.fn(async () => undefined),
}));
vi.mock("./subagent-control-session.js", () => ({
  prepareSubagentKillSession: async (
    _config: unknown,
    _sessionKey: string,
    assertOwner: () => void,
  ) => ({
    storePath: "/synthetic-retained-session/sessions.json",
    entry: {
      sessionId: fixture.sessionId,
      lifecycleRevision: fixture.lifecycleRevision,
      updatedAt: 1,
    },
    assertCurrent: assertOwner,
    withPublication: async <T>(run: () => Promise<T>) => {
      assertOwner();
      return await run();
    },
    release: () => {},
  }),
}));
vi.mock("../../../gateway/call.js", () => ({ callGateway: vi.fn() }));
vi.mock("./subagent-session-reconciliation.js", () => ({
  loadSubagentSessionEntry: () => ({
    sessionId: fixture.sessionId,
    lifecycleRevision: fixture.lifecycleRevision,
  }),
}));

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  vi.mocked(applySessionEntryExactReplacements).mockClear();
  subagentRuns.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const stored = await readStored();
  for (const [id, entry] of stored) {
    subagentRuns.set(id, entry);
  }
  await mutateSubagentRuns([...stored.keys()], () => ({
    value: undefined,
    postimages: new Map([...stored.keys()].map((id) => [id, null])),
  }));
  subagentRuns.clear();
});

async function readStored() {
  const reply = await executeExistingOpenClawStateRead(
    { env: state.env },
    { type: "subagents.runs", scope: { kind: "all" } },
  );
  if (!reply?.ok || reply.type !== "subagents.runs" || reply.projection) {
    throw new Error("Queued recovery fixture could not read its durable registry");
  }
  return reply.runs;
}

function createRegistrationFixture() {
  const refusal = { descriptor: true, terminal: false };
  const execute = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    (owner, run, options) =>
      execute(
        owner,
        (scope) =>
          run({
            execute: async (command, executeOptions) => {
              if (isSubagentRegistryWriteCommand(command)) {
                const rows = command.input.values.map(rowToSubagentRunRecord);
                if (refusal.descriptor && rows.some((row) => row?.queuedLaunch)) {
                  throw new Error("descriptor refused");
                }
                if (refusal.terminal && rows.some((row) => row?.execution.status === "terminal")) {
                  throw new Error("terminal settlement refused");
                }
              }
              return scope.execute(command, executeOptions);
            },
          }),
        options,
      ),
  );
  const options: SubagentManagerOptions = {
    acquireTerminalCompletionLock: async () => () => {},
    runs: subagentRuns,
    getRunsForChildSession: (key) =>
      [...subagentRuns.values()].filter((run) => run.childSessionKey === key),
    resumedRuns: new Set(),
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
    resolveSubagentSessionCompletion: async () => null,
    resolveSubagentSessionStartedAt: async () => undefined,
    notifyContextEngineSubagentEnded: async () => {},
    completeCleanupBookkeeping: async () => {},
    completeSubagentRun: async () => {},
  };
  const manager = createSubagentRunManager(options);
  return { refusal, manager };
}

it.each(["restart", "restart with newer sibling", "confirmed Stop"] as const)(
  "reconciles a retained descriptorless registration through %s",
  async (recovery) => {
    const newerSibling = recovery === "restart with newer sibling";
    const { refusal, manager } = createRegistrationFixture();
    refusal.terminal = true;
    let ownership: SubagentRegistrationScope | undefined;
    const runId = "retained-registration";
    const childSessionKey = "agent:main:subagent:retained-registration";
    const settleRootWork = observeRootWork();
    const sql = observeMainThreadSql();
    const transport = vi.mocked(callGateway).mockReset().mockResolvedValue({});
    const cleanupResources = vi.fn(async () => true);
    const cleaned = vi.fn(async () => {});
    const resume = vi.fn();
    const startQueued = vi.fn(async () => true);
    const restorer = createSubagentRegistryRestorer({
      runs: subagentRuns,
      getGatewayContextResolver: () => undefined,
      bindGatewayOwners: () => true,
      settleRequesterTurn: async () => false,
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
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ outcome: "not-committed" }),
        errors: [
          expect.objectContaining({
            outcome: "not-committed",
            message: expect.stringContaining("descriptor refused"),
          }),
          expect.objectContaining({
            outcome: "not-committed",
            message: expect.stringContaining("terminal settlement refused"),
          }),
        ],
      });
      refusal.terminal = false;
      expect((await readStored()).get(runId)?.queuedLaunch).toBeUndefined();
      expect((await readStored()).get(runId)?.execution.status).toBe("queued");
      expect(expectDefined(ownership, "registration scope").canCleanupSession()).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(cleanupResources).not.toHaveBeenCalled();

      if (recovery === "confirmed Stop") {
        expect(await manager.markSubagentRunTerminated({ runId })).toBe(1);
        const stopped = expectDefined(subagentRuns.get(runId), "stopped original run");
        const stoppedExecution = stopped.execution;
        expect((await readStored()).get(runId)?.killReconciliation).toBeDefined();
        await expect(
          expectDefined(ownership, "registration scope").settleFailedLaunch("later callback"),
        ).resolves.toBeUndefined();
        expect(subagentRuns.get(runId)?.execution).toEqual(stoppedExecution);
        expect(expectDefined(ownership, "registration scope").canCleanupSession()).toBe(false);
        expect(applySessionEntryExactReplacements).toHaveBeenCalled();
        return;
      }
      if (newerSibling) {
        const original = expectDefined((await readStored()).get(runId), "retained original intent");
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
        await mutateSubagentRuns([successor.runId], () => ({
          value: undefined,
          postimages: new Map([[successor.runId, successor]]),
        }));
      }
      subagentRuns.clear();
      await restorer.restoreOnce();
      await restorer.activate();
      await settleRootWork(true);
      expect((await readStored()).get(runId)?.execution.status).toBe("terminal");
      expect((await readStored()).get(runId)).toMatchObject({
        execution: { status: "terminal", lifecycleGeneration: getAgentEventLifecycleGeneration() },
        collectorCompletion: { status: "failed" },
      });
      if (newerSibling) {
        expect(transport).not.toHaveBeenCalled();
        expect(cleanupResources).not.toHaveBeenCalled();
        expect((await readStored()).get(runId)?.execution.suppressSessionEffects).toBe(true);
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
        await settleRootWork();
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    }
  },
);

it("settles an acknowledged queued launch failure through its captured native registry owner", async () => {
  const { refusal, manager } = createRegistrationFixture();
  refusal.descriptor = false;
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
  expect((await readStored()).get(runId)?.queuedLaunch).toBeDefined();
  await expectDefined(scope, "retained registration").settleFailedLaunch("launch refused");
  const terminal = expectDefined((await readStored()).get(runId), "native run after settlement");
  expect(terminal).toMatchObject({
    execution: { status: "terminal", outcome: { status: "error", error: "launch refused" } },
  });
  expect((await readStored()).get(runId)).toMatchObject({
    execution: { status: "terminal", endedAt: terminal.execution.endedAt },
    collectorCompletion: { status: "failed" },
  });
  expect((await readStored()).get(runId)?.queuedLaunch).toBeUndefined();
});
