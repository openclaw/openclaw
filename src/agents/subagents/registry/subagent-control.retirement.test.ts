// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  runSubagentStateWorkerOperation as runWorker,
  useSubagentControlFixture,
} from "./subagent-control.test-support.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
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
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { enqueueSwarmRun } from "../swarm/swarm-scheduler.lifecycle.test-support.js";
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
  markSubagentRunTerminated as terminate,
  registerSubagentRun,
} from "./subagent-registry.js";
import {
  prepareSubagentRequesterFixture,
  writeChildSession,
} from "./subagent-registry.persistence.test-support.js";
import { testing } from "./subagent-registry.test-helpers.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { resolveSubagentSessionStatus as status } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const { worker, gateway, wake, announce, capture, cleanup } = fixture;
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
type Registration = Parameters<typeof registerSubagentRun>[0];
function register(options: Pick<Registration, "runId"> & Partial<Registration>) {
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
const releaseRuns = (...runIds: string[]) => runIds.forEach(releaseSwarmRun);
async function replaceRun(entry: NonNullable<ReturnType<typeof savedRun>>) {
  await mutateSubagentRuns([entry.runId], () => ({
    value: undefined,
    postimages: new Map([[entry.runId, entry]]),
  }));
}
function putSession(storePath: string, sessionKey: string, sessionId: string, revision?: string) {
  const entry = { sessionId, lifecycleRevision: revision, updatedAt: Date.now() };
  return replaceSessionEntry({ storePath, sessionKey }, entry);
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
async function registerTree(turnOwner = false, predecessor = false) {
  const ancestorKey = childKey("ancestor");
  const storePath = await writeSession("ancestor");
  await writeSession("child");
  const family = [
    ["predecessor", ancestorKey, controllerSessionKey, true],
    ["ancestor", ancestorKey, controllerSessionKey, false],
    ["child", childKey("child"), ancestorKey, true],
  ] as const;
  for (const [runId, childSessionKey, owner, collect] of family.slice(predecessor ? 0 : 1)) {
    await register({
      runId,
      childSessionKey,
      sessionEntry: sessionEntry(storePath, childSessionKey),
      requesterSessionKey: owner,
      controllerSessionKey: runId === "predecessor" ? undefined : owner,
      requesterTurnRunId: runId === "child" && turnOwner ? "ancestor" : undefined,
      collect,
      queued: collect,
    });
  }
  return { ancestorKey, storePath };
}

it.each([
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
  expect(await terminate({ runId: "ancestor", suppressTaskDelivery: true })).toBe(1);
  const ancestor = subagentRuns.get("ancestor")!;
  expect(ancestor.killReconciliation).toMatchObject({
    killedAt: now,
    suppressTaskDelivery: true,
  });
  const dispatch = enqueue("child", "blocker");
  let lateDispatch: ReturnType<typeof enqueue> | undefined;
  try {
    const result = await killRuns({
      cfg: getRuntimeConfig(),
      controller,
      runs: [ancestor],
      beforeKill: async () => {
        // Real reconciliation retires the held ancestor while partial persistence awaits.
        clock.mockReturnValue(now + RETIRE_AFTER);
        let retirementRejected = false;
        if (transition === "retirement write rollback") {
          worker.mockImplementation((context, operation, options) =>
            runWorker(
              context,
              (scope) => {
                const execute: typeof scope.execute = async (command) => {
                  if (isRegistryWrite(command) && command.input.deleteRunIds.includes("ancestor")) {
                    retirementRejected = true;
                    throw new Error("retirement write rejected");
                  }
                  return scope.execute(command);
                };
                return operation({ ...scope, execute });
              },
              options,
            ),
          );
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
          fixture.rejectRegistryWrites((row) => row.runId === "successor", "registration rejected");
          try {
            const registration = register({
              runId: "successor",
              childSessionKey: ancestorKey,
              sessionEntry: sessionEntry(storePath, ancestorKey),
              queued: true,
            });
            await expect(registration).rejects.toThrow(
              "Queued subagent registry persistence failed",
            );
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
    expect(subagentRuns.get("child")?.collectorCompletion?.status).toBe("killed");
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
    releaseRuns("blocker", "child", "late");
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
    const completion = subagentRuns.get(child.runId)?.collectorCompletion;
    expect(completion?.status, JSON.stringify(result)).toBe("killed");
    expect(status(subagentRuns.get(child.runId))).toBe("killed");
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ found: true, killed: true, cascadeKilled: 1 });
  } finally {
    admission.release();
    await pending;
    releaseRuns("draining-blocker", child.runId);
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
  const owner = { sessionKey: childSessionKey, agentId: "other" };
  const foreign = createReplyOperation({
    ...owner,
    sessionId,
    resetTriggered: false,
    target: captureSessionTarget({
      ...owner,
      storeScope: foreignStorePath,
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
    releaseRuns("missing-blocker", "unprepared");
  }
});

function historicalCancellation(days = 9) {
  vi.mocked(resolveContextEngine).mockReset();
  wake.mockImplementation(async (params) => {
    await params.completeBatch([params.settledEntry], 1, {
      delivered: false,
      path: "none",
      error: "requester unavailable",
    });
    return false;
  });
  announce.mockResolvedValue("delivered");
  capture.mockResolvedValue(undefined);
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
  return { input, runId: input.subagent.runId };
}

async function persistRetiredOwner(input: ReturnType<typeof records>) {
  await prepareSubagentRequesterFixture(input.subagent, { stateDir: fixture.stateDir });
  const database = openOpenClawStateDatabase();
  seedSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
}

function expectNoExecutionReplay() {
  for (const replay of [announce, capture, cleanup, gateway]) {
    expect(replay).not.toHaveBeenCalled();
  }
}

it.each([-1, 1])("ignores killed callbacks after cancellation cleanup (%ims)", async (offset) => {
  const { input, runId } = historicalCancellation();
  input.subagent.killReconciliation = undefined;
  await persistRetiredOwner(input);
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  input.subagent = subagentRuns.get(runId)!;
  const driver = requesterWakeDriver([input]);
  const before = structuredClone(input.subagent);
  try {
    await driver.controller.completeSubagentRun({
      runId,
      expectedEntry: input.subagent,
      endedAt: input.subagent.execution.endedAt! + offset,
      reason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "stopped" },
      triggerCleanup: true,
    });

    expect(input.subagent).toEqual(before);
    expect(savedRun(runId)).toEqual(before);
    expect(driver.wake).not.toHaveBeenCalled();
    expectNoExecutionReplay();
  } finally {
    driver.controller.clearRuntimeState();
  }
});
