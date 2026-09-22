/** Registry projections must agree with admitted execution and queue owners. */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { projectGatewaySessionRunState } from "../../../gateway/session-utils-display.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunContextOwnerStatus,
  hasLiveAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
  rotateAgentRunRegistryLifecycleGeneration,
  sweepStaleRunContexts,
} from "../../../infra/agent-run-registry.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { finalizeTaskRunByRunId } from "../../../tasks/detached-task-runtime.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../../admitted-run-context.js";
import { resolveSpawnAdmission } from "../../spawn-plan.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { blockSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import {
  activateSwarmRun,
  isSwarmRunWaitingForCapacity,
  removeQueuedSwarmRun,
  reserveSwarmRun,
} from "../swarm/swarm-scheduler.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { buildSubagentList } from "./subagent-list.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import {
  buildSubagentSessionListReadIndex,
  countActiveDescendantRuns,
  countPendingDescendantRuns,
  hasDescendantRunAwaitingSettle,
  hasSubagentTaskOwner,
  isSubagentRunLive,
  isSubagentRunQueued,
  isSubagentSessionRunActive,
} from "./subagent-registry-read.js";
import { preserveSubagentRunForRestart } from "./subagent-registry-run-wait.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  countActiveRunsForSession,
  markSubagentRunTerminated,
  registerSubagentRun,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { addSubagentRunForTests, testing } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();
const parent = "agent:main:liveness-parent";
const start = Date.parse("2026-09-13T12:00:00Z");
const olderThanCutoff = start + 2 * 60 * 60 * 1000 + 1;
afterEach(() => resetCommandQueueStateForTest());

async function register(id: string, collect = false, expectsCompletionMessage = false) {
  const childSessionKey = `agent:main:subagent:${id}`;
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: `${id}-session`,
    lifecycleRevision: `${id}-revision`,
  });
  registerSubagentRun({
    runId: id,
    childSessionKey,
    requesterSessionKey: parent,
    requesterAgentId: "main",
    requesterDisplayKey: parent,
    task: "quiet owner proof",
    cleanup: "keep",
    runTimeoutSeconds: 0,
    expectsCompletionMessage,
    ...(collect
      ? { collect: true, queued: true, swarmRequesterSessionKey: parent, groupId: "liveness-group" }
      : {}),
  });
  return subagentRuns.get(id)!;
}

it("retains quiet admitted execution in listing, admission count, and requester settlement after two hours", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  const entry = await register("quiet-owned");
  const entered = createDeferred();
  const finish = createDeferred();
  const admission = prepareSystemAgentRunAdmission(
    getRuntimeConfig(),
    entry.runId,
    "main",
    "liveness-owner-proof",
  );
  const task = enqueueCommandInLane("test:liveness-quiet", async () => {
    const context = await admission.admit("embedded");
    const authority = getAdmittedRunDelegatedAuthority(context)!;
    expect(
      getAgentRunContextOwnerStatus(entry.runId, authority.claimId, authority.lifecycleGeneration),
    ).toBe("active");
    entered.resolve();
    try {
      await finish.promise;
    } finally {
      admission.close();
    }
  });
  try {
    await entered.promise;
    now.mockReturnValue(olderThanCutoff);
    expect(getCommandLaneSnapshot("test:liveness-quiet").activeCount).toBe(1);
    expect(isSubagentRunLive(entry)).toBe(true);
    expect(sweepStaleRunContexts()).toBe(0);
    await testing.sweepOnceForTests();
    expect(entry.execution.endedAt).toBeUndefined();
    expect(getAgentRunContext(entry.runId)).toBeDefined();
    expect
      .soft(
        resolveSpawnAdmission({
          cfg: { agents: { defaults: { subagents: { maxChildrenPerAgent: 1 } } } },
          requesterSessionKey: parent,
          requesterAgentId: "main",
          targetAgentId: "main",
          configuredAgentIds: ["main"],
        }).ok,
      )
      .toBe(false);
    expect.soft(countActiveRunsForSession(parent)).toBe(1);
    expect.soft(countActiveDescendantRuns(parent)).toBe(1);
    expect.soft(countPendingDescendantRuns(parent)).toBe(1);
    expect.soft(hasDescendantRunAwaitingSettle(parent)).toBe(true);
    expect.soft(isSubagentSessionRunActive(entry.childSessionKey)).toBe(true);
    expect
      .soft(
        buildSubagentList({ cfg: getRuntimeConfig(), runs: [entry], recentMinutes: 30 }).active.map(
          (row) => ({ runId: row.runId, execution: row.execution.state }),
        ),
      )
      .toEqual([{ runId: entry.runId, execution: "running" }]);
    // A persisted completed sibling already owns an unfrozen settle outbox.
    addSubagentRunForTests({
      runId: "settled-sibling",
      childSessionKey: "agent:main:subagent:settled-sibling",
      requesterSessionKey: parent,
      requesterAgentId: "main",
      requesterDisplayKey: parent,
      task: "completed sibling",
      cleanup: "keep",
      createdAt: start,
      startedAt: start,
      endedAt: start + 1,
      outcome: { status: "ok" },
      cleanupCompletedAt: start + 2,
      expectsCompletionMessage: false,
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    });
    const sibling = subagentRuns.get("settled-sibling")!;
    const completeBatch = vi.fn();
    const transitionBatch = vi.fn();
    await maybeWakeRequesterAfterAllChildrenSettled({
      requesterSessionKey: parent,
      settledEntry: sibling,
      completeBatch,
      transitionBatch,
    });
    expect.soft(completeBatch).not.toHaveBeenCalled();
    expect.soft(transitionBatch).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await task;
    expect(isSubagentRunLive(entry)).toBe(false);
    expect(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
    expect(countActiveRunsForSession(parent)).toBe(0);
    now.mockRestore();
  }
});

it("retains an exact queued collector reservation without calling it executor-live", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  expect(
    reserveSwarmRun({
      groupId: "liveness-group",
      runId: "queued-owned",
      maxConcurrent: 1,
      activeRunIds: ["occupied-slot"],
    }),
  ).toBe(true);
  const entry = await register("queued-owned", true);
  const launch = vi.fn(async () => {});
  activateSwarmRun({
    groupId: "liveness-group",
    runId: entry.runId,
    start: launch,
    onStartFailure: () => true,
  });
  await Promise.resolve();
  now.mockReturnValue(olderThanCutoff);
  expect(isSwarmRunWaitingForCapacity(entry.runId, entry)).toBe(true);
  expect(isSubagentRunQueued(entry)).toBe(true);
  expect(isSubagentRunQueued({ ...entry })).toBe(false);
  expect(isSubagentRunLive(entry)).toBe(false);
  expect(findTaskByRunId(entry.runId)?.status).toBe("queued");
  expect(launch).not.toHaveBeenCalled();
  // sessions.list projects compact copies for descendant accounting, while its
  // direct display lookup deliberately preserves the exact process-local row.
  const index = buildSubagentSessionListReadIndex();
  const projected = index.listDescendantRunsForRequester(parent)[0]!;
  expect(projected).not.toBe(entry);
  expect(projected.runId).toBe(entry.runId);
  expect(isSubagentRunQueued(projected)).toBe(false);
  expect.soft(index.countActiveDescendantRuns(parent)).toBe(1);
  expect.soft(index.countPendingDescendantRuns(parent)).toBe(1);
  expect.soft(index.hasDescendantRunAwaitingSettle(parent)).toBe(true);
  expect
    .soft(projectGatewaySessionRunState({ key: parent, now: olderThanCutoff }).fields)
    .toMatchObject({ hasActiveSubagentRun: true });
  expect.soft(countActiveRunsForSession(parent, { collect: true })).toBe(1);
  expect.soft(countActiveRunsForSession(parent, { collect: false })).toBe(0);
  expect.soft(countPendingDescendantRuns(parent)).toBe(1);
  expect.soft(hasDescendantRunAwaitingSettle(parent)).toBe(true);
  expect
    .soft(
      buildSubagentList({ cfg: getRuntimeConfig(), runs: [entry], recentMinutes: 30 }).active.map(
        (row) => ({ status: row.status, execution: row.execution.state }),
      ),
    )
    .toEqual([{ status: "queued", execution: "queued" }]);
  const captured = buildSubagentRunReadIndexFromRuns({
    runs: new Map([[projected.runId, projected]]),
    inMemoryRuns: [entry],
    now: olderThanCutoff,
  });
  expect(removeQueuedSwarmRun(entry.runId)).toBe(true);
  expect(captured.countActiveDescendantRuns(parent)).toBe(0);
  expect(captured.countPendingDescendantRuns(parent)).toBe(0);
  expect(captured.hasDescendantRunAwaitingSettle(parent)).toBe(false);
  expect(isSubagentRunQueued(entry)).toBe(false);
  expect(countActiveRunsForSession(parent, { collect: true })).toBe(0);
  expect(hasDescendantRunAwaitingSettle(parent)).toBe(false);
  const released = buildSubagentSessionListReadIndex();
  expect(released.countActiveDescendantRuns(parent)).toBe(0);
  expect(released.countPendingDescendantRuns(parent)).toBe(0);
  expect(released.hasDescendantRunAwaitingSettle(parent)).toBe(false);
  expect(
    projectGatewaySessionRunState({ key: parent, now: olderThanCutoff }).fields,
  ).not.toMatchObject({ hasActiveSubagentRun: true });
});

it("does not retain an old run after its last claim releases preserved routing metadata", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  const entry = await register("preserved-unowned");
  // Admission/event routing can publish metadata before a tracked execution
  // adopts it. A non-owning claim must preserve that metadata when it exits.
  registerAgentRunContext(entry.runId, { sessionKey: entry.childSessionKey });
  const routingContext = getAgentRunContext(entry.runId)!;
  const claim = claimAgentRunContext(
    entry.runId,
    { sessionKey: entry.childSessionKey },
    { trackOwner: true, ownsContext: false },
  );
  expect(claim).toBeDefined();
  try {
    now.mockReturnValue(olderThanCutoff);
    expect(hasLiveAgentRunContext(entry.runId)).toBe(true);
    expect(isSubagentRunLive(entry)).toBe(true);
    expect(countActiveRunsForSession(parent)).toBe(1);
    releaseAgentRunContext(entry.runId, claim);
    expect(getAgentRunContext(entry.runId)).toBe(routingContext);
    expect(hasLiveAgentRunContext(entry.runId)).toBe(false);
    expect.soft(isSubagentRunLive(entry)).toBe(false);
    expect.soft(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
    expect.soft(countActiveRunsForSession(parent)).toBe(0);
    expect.soft(countPendingDescendantRuns(parent)).toBe(0);
    expect.soft(hasDescendantRunAwaitingSettle(parent)).toBe(false);
    expect.soft(buildSubagentSessionListReadIndex().countActiveDescendantRuns(parent)).toBe(0);
  } finally {
    releaseAgentRunContext(entry.runId, claim);
    clearAgentRunContext(entry.runId);
  }
});

it("does not transfer read retention across replaced queue owners or copied reservations", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  const id = "queue-generation";
  const reserve = () =>
    reserveSwarmRun({
      groupId: "liveness-group",
      runId: id,
      maxConcurrent: 1,
      activeRunIds: ["occupied-slot"],
    });
  expect(reserve()).toBe(true);
  const original = await register(id, true);
  now.mockReturnValue(olderThanCutoff);
  const snapshot = buildSubagentSessionListReadIndex();
  const compact = snapshot.listDescendantRunsForRequester(parent)[0]!;
  expect(isSubagentRunQueued(original)).toBe(true);
  expect(isSubagentRunQueued(compact)).toBe(false);
  expect(
    buildSubagentRunReadIndexFromRuns({
      runs: new Map([[id, compact]]),
      inMemoryRuns: [{ ...original }],
    }).countActiveDescendantRuns(parent),
  ).toBe(0);

  now.mockReturnValue(start);
  const replacement = await register(id, true);
  now.mockReturnValue(olderThanCutoff);
  expect(replacement).not.toBe(original);
  expect(replacement.generation).toBeGreaterThan(original.generation!);
  expect(isSubagentRunQueued(original)).toBe(false);
  expect(isSubagentRunQueued(replacement)).toBe(false);
  expect(snapshot.countActiveDescendantRuns(parent)).toBe(0);
  expect(snapshot.hasDescendantRunAwaitingSettle(parent)).toBe(false);
  expect(buildSubagentSessionListReadIndex().countPendingDescendantRuns(parent)).toBe(0);

  expect(removeQueuedSwarmRun(id)).toBe(true);
  expect(reserve()).toBe(true);
  now.mockReturnValue(start);
  const successor = await register(id, true);
  now.mockReturnValue(olderThanCutoff);
  expect(isSubagentRunQueued(successor)).toBe(true);
  expect(buildSubagentSessionListReadIndex().countActiveDescendantRuns(parent)).toBe(1);
  // A previously issued projection cannot borrow the new generation's owner.
  expect(
    buildSubagentRunReadIndexFromRuns({
      runs: new Map([[id, compact]]),
      inMemoryRuns: subagentRuns.values(),
    }).countActiveDescendantRuns(parent),
  ).toBe(0);
  const current = buildSubagentSessionListReadIndex().listDescendantRunsForRequester(parent)[0]!;
  const otherParent = "agent:main:other-parent";
  expect(
    buildSubagentRunReadIndexFromRuns({
      runs: new Map([[id, { ...current, requesterSessionKey: otherParent }]]),
      inMemoryRuns: subagentRuns.values(),
    }).countActiveDescendantRuns(otherParent),
  ).toBe(0);
  expect(isSubagentRunQueued(current)).toBe(false);
  expect(isSubagentRunQueued(structuredClone(successor))).toBe(false);
  expect(removeQueuedSwarmRun(id)).toBe(true);
  expect(buildSubagentSessionListReadIndex().countActiveDescendantRuns(parent)).toBe(0);
});

it("rejects an owned context once its Gateway lifecycle retires", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  const entry = await register("retired-context");
  const claim = claimAgentRunContext(
    entry.runId,
    {
      sessionKey: entry.childSessionKey,
    },
    { trackOwner: true, ownsContext: true },
  );
  try {
    now.mockReturnValue(olderThanCutoff);
    expect(isSubagentRunLive(entry)).toBe(true);
    expect(countActiveRunsForSession(parent)).toBe(1);
    rotateAgentRunRegistryLifecycleGeneration();
    expect(hasLiveAgentRunContext(entry.runId)).toBe(false);
    expect(isSubagentRunLive(entry)).toBe(false);
    expect(countActiveRunsForSession(parent)).toBe(0);
  } finally {
    releaseAgentRunContext(entry.runId, claim);
  }
});

it("does not keep a recent orphan executor-live after its admitted owner closes", async () => {
  vi.spyOn(Date, "now").mockReturnValue(start);
  const entry = await register("recent-unowned");
  const admission = prepareSystemAgentRunAdmission(
    getRuntimeConfig(),
    entry.runId,
    "main",
    "recent-owner-loss-proof",
  );
  await enqueueCommandInLane("test:liveness-owner-loss", async () => {
    await admission.admit("embedded");
    try {
      expect(isSubagentRunLive(entry)).toBe(true);
    } finally {
      admission.close();
    }
  });
  // The executor closed before the registry observed a terminal lifecycle event.
  expect(entry.execution.endedAt).toBeUndefined();
  expect(getAgentRunContext(entry.runId)).toBeUndefined();
  expect(isSubagentRunLive(entry)).toBe(false);
  expect(isSubagentRunQueued(entry)).toBe(false);
  expect(findTaskByRunId(entry.runId)?.status).toBe("running");
  expect.soft(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
});

it("retains durable suspended completion debt without reporting a live executor or awaiting automatic settlement", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  const entry = await register("suspended-debt", false, true);
  // Restore a terminal result awaiting delivery, then use the real atomic suspension owner.
  entry.execution = {
    ...entry.execution,
    status: "terminal",
    endedAt: start + 1,
    outcome: { status: "ok" },
  };
  entry.completion = { required: true, resultText: "completed result", capturedAt: start + 1 };
  persistSubagentRunsToDiskOrThrow(subagentRuns, [entry.runId]);
  finalizeTaskRunByRunId({
    runId: entry.runId,
    runtime: "subagent",
    sessionKey: entry.childSessionKey,
    status: "succeeded",
    endedAt: start + 1,
  });
  now.mockReturnValue(olderThanCutoff);
  expect(countPendingDescendantRuns(parent)).toBe(1);
  expect(hasDescendantRunAwaitingSettle(parent)).toBe(true);
  const task = findTaskByRunId(entry.runId)!;
  expect(
    blockSubagentCompletionDelivery({
      subagent: entry,
      taskId: task.taskId,
      reason: "delivery budget exhausted",
      suspendedReason: "expiry",
    }),
  ).toBe(true);
  const suspended = subagentRuns.get(entry.runId)!;
  expect(suspended.delivery?.status).toBe("suspended");
  expect(countPendingDescendantRuns(parent)).toBe(1);
  expect(hasDescendantRunAwaitingSettle(parent)).toBe(false);
  expect(isSubagentRunLive(suspended)).toBe(false);
  expect(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
  expect(countActiveRunsForSession(parent)).toBe(0);
  subagentRuns.clear();
  expect(
    hasSubagentTaskOwner({
      taskRunId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: parent,
    }),
  ).toBe(true);
});

it("keeps a restart-preserved task owner distinct from an executor", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  const entry = await register("interrupted-task");
  expect(
    preserveSubagentRunForRestart({
      entry,
      terminal: { reason: "cancelled", status: "error", stopReason: "restart", endedAt: start + 1 },
      persist: (...ids) => persistSubagentRunsToDiskOrThrow(subagentRuns, ids),
    }),
  ).toBe(true);
  now.mockReturnValue(olderThanCutoff);
  expect(entry.execution.status).toBe("interrupted");
  expect(entry.execution.endedAt).toBeUndefined();
  expect(isSubagentRunLive(entry)).toBe(false);
  expect(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
  subagentRuns.clear();
  expect(
    hasSubagentTaskOwner({
      taskRunId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: parent,
    }),
  ).toBe(true);
});

it("makes an admitted child inactive when termination is recorded", async () => {
  const entry = await register("terminated-owner");
  const admission = prepareSystemAgentRunAdmission(
    getRuntimeConfig(),
    entry.runId,
    "main",
    "termination-owner-control",
  );
  await enqueueCommandInLane("test:liveness-termination", async () => {
    await admission.admit("embedded");
    try {
      expect(isSubagentSessionRunActive(entry.childSessionKey)).toBe(true);
      expect(
        markSubagentRunTerminated({
          childSessionKey: entry.childSessionKey,
          reason: "manual kill",
        }),
      ).toBe(1);
      expect(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
    } finally {
      admission.close();
    }
  });
});
