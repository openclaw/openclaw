// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  runSubagentStateWorkerOperation as runWorker,
  useSubagentControlFixture,
} from "./subagent-control.test-support.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import {
  createSubagentRunRecord,
  isSubagentRegistryWriteCommand as isRegistryWrite,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  records,
  requesterWakeDriver,
  seedSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "./subagent-control-native.test-support.js";
import {
  killAllControlledSubagentRuns as killRuns,
  killSubagentRunAdmin,
} from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS as RETIRE_AFTER } from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  markSubagentRunTerminated as terminate,
  registerSubagentRun,
  resumeSubagentRun,
} from "./subagent-registry.js";
import {
  prepareSubagentRecoveryFixture,
  writeChildSession,
} from "./subagent-registry.persistence.test-support.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "./subagent-registry.store.kernel.js";
import { testing } from "./subagent-registry.test-helpers.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { resolveSubagentSessionStatus as status } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const { worker, gateway } = fixture;
const controllerSessionKey = "agent:main:main";
const controller = {
  controllerSessionKey,
  controllerAgentId: "main",
  callerSessionKey: controllerSessionKey,
  callerIsSubagent: false,
  controlScope: "children" as const,
};
const childKey = (runId: string) => `agent:main:subagent:${runId}`;
const identity = (runId: string) => ({
  sessionId: `${runId}-session`,
  lifecycleRevision: `${runId}-revision`,
});
function register(
  options: Pick<Parameters<typeof registerSubagentRun>[0], "runId"> &
    Partial<Parameters<typeof registerSubagentRun>[0]>,
) {
  return registerSubagentRun({
    childSessionKey: childKey(options.runId),
    sessionEntry: identity(options.runId),
    task: options.runId,
    childAgentId: "main",
    requesterSessionKey: controllerSessionKey,
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    cleanup: "keep",
    expectsCompletionMessage: false,
    ...options,
  });
}
const writeSession = (runId: string) =>
  writeChildSession(fixture.stateDir, childKey(runId), `${runId}-session`, `${runId}-revision`);
const sessionEntry = (storePath: string, sessionKey: string) =>
  loadSessionEntry({ storePath, sessionKey });
const savedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);
async function replaceRun(entry: NonNullable<ReturnType<typeof savedRun>>) {
  await mutateSubagentRuns([entry.runId], () => ({
    value: undefined,
    postimages: new Map([[entry.runId, entry]]),
  }));
}
function putSession(storePath: string, sessionKey: string, sessionId: string, revision?: string) {
  return replaceSessionEntry(
    { storePath, sessionKey },
    {
      sessionId,
      lifecycleRevision: revision,
      updatedAt: Date.now(),
    },
  );
}
function enqueue(runId: string, blocker?: string) {
  const start = vi.fn(async () => {});
  enqueueSwarmRun({
    groupId: runId,
    runId,
    maxConcurrent: 1,
    activeRunIds: blocker ? [blocker] : [],
    start,
    onStartFailure: () => true,
  });
  return start;
}
function rejectWrite(reject: (write: Parameters<typeof isRegistryWrite>[0]) => boolean) {
  worker.mockImplementation((context, operation, options) =>
    runWorker(
      context,
      (scope) =>
        operation({
          ...scope,
          execute: async (command) => {
            if (reject(command)) {
              throw new Error("registry write rejected");
            }
            return scope.execute(command);
          },
        }),
      options,
    ),
  );
}
async function registerTree(turnOwner = false, predecessor = false) {
  const ancestorKey = childKey("ancestor");
  const storePath = await writeSession("ancestor");
  await writeSession("child");
  if (predecessor) {
    await register({
      runId: "predecessor",
      childSessionKey: ancestorKey,
      sessionEntry: sessionEntry(storePath, ancestorKey),
      collect: true,
      queued: true,
    });
  }
  for (const [runId, owner, collect] of [
    ["ancestor", controllerSessionKey, false],
    ["child", ancestorKey, true],
  ] as const) {
    await register({
      runId,
      sessionEntry: sessionEntry(storePath, childKey(runId)),
      requesterSessionKey: owner,
      controllerSessionKey: owner,
      requesterTurnRunId: collect && turnOwner ? "ancestor" : undefined,
      collect,
      queued: collect,
    });
  }
  return { ancestorKey, storePath };
}

it.each([
  "normal retirement",
  "retirement with retained predecessor",
  "retirement write rollback",
  "successor registration write rollback",
  "new direct child after retirement",
])("preserves captured cancellation ownership through %s", async (transition) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { ancestorKey, storePath } = await registerTree(
    false,
    transition === "retirement with retained predecessor",
  );
  const child = subagentRuns.get("child")!;
  expect(await terminate({ runId: "ancestor", suppressTaskDelivery: true })).toBe(1);
  const ancestor = subagentRuns.get("ancestor")!;
  expect(ancestor.killReconciliation).toMatchObject({
    killedAt: now,
    suppressTaskDelivery: true,
  });
  expect(subagentRuns.get("ancestor")).toBe(ancestor);
  const dispatch = enqueue("child", "blocker");
  let lateDispatch: ReturnType<typeof enqueue> | undefined;
  try {
    const result = await killRuns({
      cfg: getRuntimeConfig(),
      controller,
      runs: [ancestor],
      beforeKill: async () => {
        // The retry already holds the child. Real reconciliation, not a map edit,
        // now retires the aged keep-mode ancestor while partial persistence awaits.
        clock.mockReturnValue(now + RETIRE_AFTER);
        let retirementRejected = false;
        if (transition === "retirement write rollback") {
          rejectWrite((command) => {
            const rejects =
              isRegistryWrite(command) && command.input.deleteRunIds.includes("ancestor");
            retirementRejected ||= rejects;
            return rejects;
          });
        }
        await testing.sweepOnceForTests();
        if (transition === "retirement write rollback") {
          await vi.waitFor(() => expect(retirementRejected).toBe(true));
          await fixture.settle();
          const retained = subagentRuns.get("ancestor");
          expect(isSameSubagentRunOwner(retained, ancestor)).toBe(true);
          expect(retained).toMatchObject({
            controllerSessionKey: ancestor.controllerSessionKey,
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            delivery: { status: "not_required" },
            cleanupHandled: false,
          });
          expect(retained?.execution).toEqual(ancestor.execution);
          expect(retained?.killReconciliation).toBeUndefined();
          expect(retained?.cleanupCompletedAt).toBeUndefined();
          expect(savedRun("ancestor")).toEqual(retained);
          worker.mockImplementation(runWorker);
        } else {
          await vi.waitFor(() => expect(subagentRuns.has("ancestor")).toBe(false));
        }
        if (transition.includes("successor")) {
          rejectWrite(
            (command) =>
              isRegistryWrite(command) &&
              command.input.values.some((row) => row.run_id === "successor"),
          );
          try {
            await expect(
              register({
                runId: "successor",
                childSessionKey: ancestorKey,
                sessionEntry: sessionEntry(storePath, ancestorKey),
                queued: true,
              }),
            ).rejects.toThrow("Queued subagent registry persistence failed");
            expect(subagentRuns.has("successor")).toBe(false);
            expect(loadSubagentRegistryFromSqlite().has("successor")).toBe(false);
          } finally {
            worker.mockImplementation(runWorker);
          }
        } else if (transition === "new direct child after retirement") {
          await writeSession("late");
          await register({
            runId: "late",
            requesterSessionKey: ancestorKey,
            queued: true,
            collect: true,
          });
          lateDispatch = enqueue("late");
        }
        expect(sessionEntry(storePath, ancestorKey)).toBeDefined();
        expect(gateway.mock.calls.some(([request]) => request.method === "sessions.delete")).toBe(
          false,
        );
        expect(releaseSwarmRun("blocker")).toBe(true);
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
        return true;
      },
    });
    expect(result).toMatchObject({ status: "ok", killed: 1 });
    expect(subagentRuns.get(child.runId)?.collectorCompletion?.status).toBe("killed");
    expect(dispatch).not.toHaveBeenCalled();
    if (transition === "retirement with retained predecessor") {
      expect(subagentRuns.get("predecessor")?.execution.status).toBe("queued");
    }
    if (transition === "new direct child after retirement") {
      expect(lateDispatch).toHaveBeenCalledOnce();
      expect(subagentRuns.get("late")?.killIntent).toBeUndefined();
      expect(status(subagentRuns.get("late"))).toBe("queued");
    }
  } finally {
    releaseSwarmRun("blocker");
    releaseSwarmRun("child");
    releaseSwarmRun("late");
  }
});

it.each([
  { boundary: "bulk", transition: "lifecycle rotation" },
  ...["ordinary retirement", "session replacement", "owner replacement"].map((transition) => ({
    boundary: "admin",
    transition,
  })),
])("handles $transition during $boundary admission drain", async ({ boundary, transition }) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { ancestorKey, storePath } = await registerTree(true);
  const ancestor = subagentRuns.get("ancestor")!;
  const child = subagentRuns.get("child")!;
  const entered = createDeferred();
  const admission = await beginSessionEffect({
    scope: storePath,
    identities: [ancestorKey, "ancestor-session"],
    run: {
      runId: ancestor.runId,
      sessionKey: ancestorKey,
      sessionId: "ancestor-session",
      agentId: "main",
    },
    assertAllowed: () => {},
    onInterrupt: () => {
      entered.resolve();
      return { runId: ancestor.runId };
    },
  });
  const dispatch = enqueue(child.runId, "draining-blocker");
  const cfg = getRuntimeConfig();
  const pending =
    boundary === "bulk"
      ? killRuns({ cfg, controller, runs: [ancestor] })
      : killSubagentRunAdmin({
          cfg,
          sessionKey: ancestorKey,
          expectedRunId: ancestor.runId,
          expectedGeneration: ancestor.generation,
          expectedOwnerKey: controllerSessionKey,
        });
  try {
    await entered.promise;
    // Independent canonical termination during the drain, followed by modeled
    // reconciliation ageing. A fresh provisional kill must still retain its row.
    expect(await terminate({ runId: ancestor.runId, suppressTaskDelivery: true })).toBe(1);
    expect(subagentRuns.get(ancestor.runId)?.killReconciliation?.killedAt).toBe(now);
    clock.mockReturnValue(now + RETIRE_AFTER);
    await testing.sweepOnceForTests();
    await vi.waitFor(() => expect(subagentRuns.has(ancestor.runId)).toBe(false));
    expect(sessionEntry(storePath, ancestorKey)?.sessionId).toBe("ancestor-session");
    if (transition === "session replacement") {
      await putSession(storePath, ancestorKey, "replacement-session");
    } else if (transition === "lifecycle rotation") {
      rotateAgentEventLifecycleGeneration();
    } else if (transition === "owner replacement") {
      await replaceRun({
        ...ancestor,
        controllerSessionKey: "agent:other:main",
        requesterSessionKey: "agent:other:main",
      });
    }
    expect(releaseSwarmRun("draining-blocker")).toBe(true);
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    admission.release();
    const result = await pending;
    expect(subagentRuns.has(ancestor.runId)).toBe(transition === "owner replacement");
    if (transition !== "ordinary retirement") {
      expect(subagentRuns.get(child.runId)?.killIntent).toBeUndefined();
      expect(subagentRuns.get(child.runId)?.collectorCompletion).toBeUndefined();
      expect(status(subagentRuns.get(child.runId))).toBe("queued");
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      return;
    }
    expect(subagentRuns.get(child.runId)?.collectorCompletion?.status, JSON.stringify(result)).toBe(
      "killed",
    );
    expect(status(subagentRuns.get(child.runId))).toBe("killed");
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject(
      boundary === "bulk"
        ? { status: "ok", killed: 1 }
        : { found: true, killed: true, cascadeKilled: 1 },
    );
  } finally {
    admission.release();
    await pending;
    releaseSwarmRun("draining-blocker");
    releaseSwarmRun(child.runId);
  }
});

it.each([
  ["default", undefined],
  ["template", "stores/{agentId}/sessions.json"],
  ["fixed JSON-style", "fixed/sessions.json"],
  ["exact SQLite", "fixed/shared.sqlite"],
])("signals only the physical non-main runtime owner (%s)", async (_, relativeStore) => {
  const store = relativeStore ? path.join(fixture.stateDir, relativeStore) : undefined;
  const storePath = resolveSessionStorePathCore(store, { agentId: "other" });
  const mainStorePath = resolveSessionStorePathCore(store, { agentId: "main" });
  const childSessionKey = "agent:other:subagent:fixed-store-child";
  const sessionId = "fixed-store-child-session";
  await putSession(mainStorePath, controllerSessionKey, "main-session");
  await putSession(storePath, childSessionKey, sessionId, `${sessionId}-revision`);
  const foreignStorePath = path.join(fixture.stateDir, "foreign", "session-control.sqlite");
  await putSession(foreignStorePath, childSessionKey, sessionId, "foreign-revision");
  const foreignEntry = sessionEntry(foreignStorePath, childSessionKey);
  await register({
    runId: "fixed-store-child",
    childSessionKey,
    childAgentId: "other",
    sessionEntry: sessionEntry(storePath, childSessionKey),
  });
  const abort = vi.fn();
  const handle = createEmbeddedRunHandle({ abort, runId: "fixed-store-child" });
  attachActiveEmbeddedRun(sessionId, handle, childSessionKey, storePath);
  const foreign = createReplyOperation({
    sessionKey: childSessionKey,
    sessionId,
    agentId: "other",
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: foreignStorePath,
      sessionKey: childSessionKey,
      agentId: "other",
      incarnation: sessionId,
    }),
  });
  const foreignAbort = vi.fn();
  foreign.attachBackend({
    kind: "embedded",
    runId: "foreign-fixed-store-child",
    isStreaming: () => true,
    cancel: foreignAbort,
  });
  try {
    const result = await killRuns({
      cfg: { ...getRuntimeConfig(), session: { store } },
      controller,
      runs: [subagentRuns.get("fixed-store-child")!],
    });
    expect(abort, JSON.stringify(result)).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "ok", killed: 1 });
    expect(foreignAbort).not.toHaveBeenCalled();
    expect(foreign.abortSignal.aborted).toBe(false);
    expect(sessionEntry(foreignStorePath, childSessionKey)).toEqual(foreignEntry);
    expect(sessionEntry(storePath, childSessionKey)?.abortedLastRun).toBe(true);
    expect(sessionEntry(mainStorePath, controllerSessionKey)?.abortedLastRun).toBeUndefined();
  } finally {
    foreign.complete();
    await detachActiveEmbeddedRun(sessionId, handle, childSessionKey);
  }
});

it("does not create a missing child database while binding cancellation", async () => {
  const childSessionKey = "agent:missing:subagent:unprepared";
  const databasePath = path.join(fixture.stateDir, "agents/missing/agent/openclaw-agent.sqlite");
  await register({
    runId: "unprepared",
    childSessionKey,
    childAgentId: "missing",
    collect: true,
    queued: true,
  });
  const dispatch = enqueue("unprepared", "missing-blocker");
  expect(existsSync(databasePath)).toBe(false);
  try {
    await expect(
      killRuns({
        cfg: getRuntimeConfig(),
        controller,
        runs: [subagentRuns.get("unprepared")!],
        beforeKill: async () => {
          expect(existsSync(databasePath)).toBe(false);
          releaseSwarmRun("missing-blocker");
          await Promise.resolve();
          expect(dispatch).not.toHaveBeenCalled();
          throw new Error("partial persistence refused");
        },
      }),
    ).rejects.toThrow("partial persistence refused");
    expect(existsSync(databasePath)).toBe(false);
    expect(subagentRuns.get("unprepared")?.killIntent).toBeUndefined();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  } finally {
    releaseSwarmRun("missing-blocker");
    releaseSwarmRun("unprepared");
  }
});

describe("restored historical cancellation ownership", () => {
  const { wake, announce, capture, cleanup } = fixture;
  beforeEach(() => {
    vi.mocked(resolveContextEngine).mockReset();
    wake.mockReset().mockImplementation(async (params) => {
      await params.completeBatch([params.settledEntry], 1, {
        delivered: false,
        path: "none",
        error: "requester unavailable",
      });
      return false;
    });
    announce.mockReset().mockResolvedValue("delivered");
    capture.mockReset().mockResolvedValue(undefined);
    cleanup.mockReset().mockResolvedValue(undefined);
  });

  const settle = fixture.settle;

  async function sweep() {
    await testing.sweepOnceForTests();
    await settle();
  }

  async function resume(runId: string, reconcile = false) {
    resumeSubagentRun(runId, "restore");
    await settle();
    if (reconcile) {
      await sweep();
    }
  }

  function historicalCancellation(days = 9) {
    const input = records();
    const endedAt = Date.now() - days * 24 * 60 * 60_000;
    input.subagent = createSubagentRunRecord({
      runId: input.subagent.runId,
      generation: 1,
      taskRunId: input.subagent.taskRunId,
      childSessionKey: input.subagent.childSessionKey,
      childSessionIdentity: input.subagent.childSessionIdentity,
      createdAt: endedAt - 60_000,
      startedAt: endedAt - 50_000,
      endedAt,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "stopped" },
      cleanupHandled: true,
      cleanupCompletedAt: endedAt,
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: endedAt - 2 },
      expectsCompletionMessage: true,
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    });
    return input;
  }

  async function persistRetiredOwner(input: ReturnType<typeof records>) {
    await prepareSubagentRecoveryFixture(input.subagent, { stateDir: fixture.stateDir });
    const database = openOpenClawStateDatabase();
    seedSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
  }

  async function restore() {
    await initSubagentRegistry();
    // These terminal-only fixtures need a live owner but never dispatch a model turn.
    const gatewayContext = { resolveGatewayContext: () => gatewayContext as never };
    await activateSubagentRegistry(() => gatewayContext as never);
  }

  function expectNoExecutionReplay() {
    for (const replay of [announce, capture, cleanup, gateway]) {
      expect(replay).not.toHaveBeenCalled();
    }
  }

  it.each([false, true])(
    "settles an uncaptured retained cancellation wake before retiring it (yielded=%s)",
    async (yielded) => {
      const input = historicalCancellation(2);
      const endedAt = input.subagent.execution.endedAt!;
      input.subagent.cleanupCompletedAt = endedAt + 30_000;
      input.subagent.killReconciliation = {
        killedAt: endedAt + 30_000,
        taskCancellationAccepted: true,
      };
      input.subagent.completionTarget = "parent";
      input.subagent.requesterSettleWake = {
        ...input.subagent.requesterSettleWake!,
        batchRunIds: [input.subagent.runId],
        ...(yielded ? { requesterYieldBatch: true, afterRequesterYield: true } : {}),
      };
      await persistRetiredOwner(input);
      await restore();
      await resume(input.subagent.runId, true);
      expect(savedRun(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
      await sweep();
      expect(loadSubagentRegistryFromSqlite().has(input.subagent.runId)).toBe(false);
      expect(wake).toHaveBeenCalledOnce();
      expectNoExecutionReplay();
    },
  );

  it("defers a rejected historical retirement write without aborting resume", async () => {
    const input = historicalCancellation();
    await persistRetiredOwner(input);
    await restore();
    const database = openOpenClawStateDatabase();
    database.db.exec(`CREATE TRIGGER reject_retired_cancellation
      BEFORE UPDATE ON subagent_runs
      BEGIN SELECT RAISE(ABORT, 'retirement write rejected'); END`);
    try {
      expect(() => resumeSubagentRun(input.subagent.runId, "restore")).not.toThrow();
      await settle();
      const saved = savedRun(input.subagent.runId)!;
      expect(saved.killReconciliation).toEqual(input.subagent.killReconciliation);
      expect(saved.requesterSettleWake).toEqual(input.subagent.requesterSettleWake);
      expect(wake).not.toHaveBeenCalled();
    } finally {
      database.db.exec("DROP TRIGGER reject_retired_cancellation");
    }

    await resume(input.subagent.runId);
    expect(savedRun(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
    expect(wake).toHaveBeenCalledOnce();
    expectNoExecutionReplay();
  });

  it.each(["before restore", "before reconciliation"] as const)(
    "preserves a newer child generation instead of waking the retired cancellation (%s)",
    async (stage) => {
      const input = historicalCancellation();
      await persistRetiredOwner(input);
      const successor = createSubagentRunRecord({
        runId: "successor-run",
        childSessionKey: input.subagent.childSessionKey,
        childSessionIdentity: input.subagent.childSessionIdentity,
        generation: 2,
        createdAt: input.subagent.createdAt + 1,
        endedAt: input.subagent.execution.endedAt,
        outcome: { status: "ok" },
        cleanupHandled: true,
        cleanupCompletedAt: input.subagent.cleanupCompletedAt,
        expectsCompletionMessage: false,
        completion: { required: false, resultText: "completed", capturedAt: Date.now() },
      });
      if (stage === "before restore") {
        writeSubagentRunValuesInDatabase(
          openOpenClawStateDatabase(),
          [bindSubagentRunRecord(successor)],
          [],
        );
      }
      await restore();
      if (stage === "before reconciliation") {
        await replaceRun(successor);
      }
      const originalBefore = savedRun(input.subagent.runId);
      const successorBefore = structuredClone(subagentRuns.get(successor.runId));
      const successorPersistedBefore = savedRun(successor.runId);
      expect(successorBefore).toMatchObject({ runId: "successor-run", generation: 2 });
      expect(successorPersistedBefore).toMatchObject({
        runId: "successor-run",
        generation: 2,
        completion: { resultText: "completed" },
      });
      await resume(input.subagent.runId, true);
      expect(savedRun(successor.runId)).toEqual(successorPersistedBefore);
      expect(subagentRuns.get(successor.runId)).toEqual(successorBefore);
      expect(savedRun(input.subagent.runId)).toEqual(originalBefore);
      expect(wake).not.toHaveBeenCalled();
      expectNoExecutionReplay();
    },
  );

  it("keeps ordinary yielded wakes ahead of terminal cleanup", async () => {
    const input = historicalCancellation();
    input.subagent.pauseReason = "sessions_yield";
    input.subagent.endedReason = undefined;
    input.subagent.killReconciliation = undefined;
    input.subagent.execution.outcome = undefined;
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.cleanupHandled = false;
    input.subagent.requesterSettleWake!.retireAfterSettle = true;
    await persistRetiredOwner(input);
    await restore();
    await settle();
    await sweep();

    const saved = savedRun(input.subagent.runId)!;
    expect(saved.requesterSettleWake).toBeUndefined();
    expect(saved.execution).toEqual(input.subagent.execution);
    expect(saved.pauseReason).toBe("sessions_yield");
    expect(saved.delivery).toEqual(input.subagent.delivery);
    expect(wake).toHaveBeenCalledOnce();
    expectNoExecutionReplay();
  });

  it.each([-1, 1])(
    "does not reopen a cleaned cancellation for a delayed killed callback (%ims)",
    async (offset) => {
      const input = historicalCancellation();
      input.subagent.killReconciliation = undefined;
      await persistRetiredOwner(input);
      await restoreSubagentRunsFromDisk({ runs: subagentRuns });
      input.subagent = subagentRuns.get(input.subagent.runId)!;
      const driver = requesterWakeDriver([input]);
      const before = structuredClone(input.subagent);
      try {
        await driver.controller.completeSubagentRun({
          runId: input.subagent.runId,
          expectedEntry: input.subagent,
          endedAt: input.subagent.execution.endedAt! + offset,
          reason: SUBAGENT_ENDED_REASON_KILLED,
          outcome: { status: "error", error: "stopped" },
          triggerCleanup: true,
        });

        expect(input.subagent).toEqual(before);
        expect(savedRun(input.subagent.runId)).toEqual(before);
        expect(driver.wake).not.toHaveBeenCalled();
        expectNoExecutionReplay();
      } finally {
        driver.controller.clearRuntimeState();
      }
    },
  );
});
