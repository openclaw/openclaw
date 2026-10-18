// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { buildSubagentsStatusLine } from "../../../auto-reply/reply/commands-status-subagents.js";
import { resolveSubagentEntryForToken } from "../../../auto-reply/reply/commands-subagents/shared.js";
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
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../../admitted-run-context.js";
import { resolveSpawnAdmission } from "../../spawn-plan.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { blockSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import { withPreparedSessionCapabilityRead } from "../spawn/subagent-session-store.js";
import {
  activateSwarmRun,
  isSwarmRunWaitingForCapacity,
  holdQueuedSwarmRun,
  reserveSwarmRun,
} from "../swarm/swarm-scheduler.js";
import { buildControlledSubagentRunsReadContext } from "./subagent-control-scope.js";
import { createControlRunFixture } from "./subagent-control.fixtures.test-support.js";
import { buildSubagentListForTests as buildSubagentList } from "./subagent-list.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import {
  buildSubagentSessionListReadIndex,
  countPendingDescendantRuns,
  isSubagentRunLive,
  isSubagentRunQueued,
  isSubagentSessionRunActive,
  listActiveSubagentSessionKeys,
} from "./subagent-registry-read.js";
import { preserveSubagentRunForRestart } from "./subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { countActiveRunsForSession, markSubagentRunTerminated } from "./subagent-registry.js";
import { addSubagentRunForTests, testing } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const controlRuns = createControlRunFixture(() => fixture.stateDir);
const parent = "agent:main:liveness-parent";
const start = Date.parse("2026-09-13T12:00:00Z");
const olderThanCutoff = start + 2 * 60 * 60 * 1000 + 1;
afterEach(async () => {
  await fixture.settle();
  resetCommandQueueStateForTest();
});

const readContext = () =>
  buildControlledSubagentRunsReadContext(parent, "main", getRuntimeConfig());
const pendingCount = () => countPendingDescendantRuns(parent, () => {});
const observe = (context: Awaited<ReturnType<typeof readContext>>, entry = context.runs[0]!) =>
  context.getExecutionObservation(entry);
const reserve = (runId: string) =>
  reserveSwarmRun({
    groupId: "liveness-group",
    runId,
    maxConcurrent: 1,
    activeRunIds: ["occupied-slot"],
  });
const clock = () => vi.spyOn(Date, "now").mockReturnValue(start);
const listRuns = (runs: SubagentRunRecord[]) =>
  buildSubagentList({ cfg: getRuntimeConfig(), runs, recentMinutes: 30 });
async function executionStates(runs: SubagentRunRecord[]) {
  return (await listRuns(runs)).active.map(({ runId, execution }) => ({
    runId,
    execution: execution.state,
  }));
}
async function listStates(runs: SubagentRunRecord[]) {
  return (await listRuns(runs)).active.map(({ status, execution }) => ({
    status,
    execution: execution.state,
  }));
}
const indexFor = (
  entry: SubagentRunRecord,
  inMemoryRuns: Iterable<SubagentRunRecord> = subagentRuns.values(),
) => buildSubagentRunReadIndexFromRuns({ runs: new Map([[entry.runId, entry]]), inMemoryRuns });
const statusLine = (context: Awaited<ReturnType<typeof readContext>>) =>
  buildSubagentsStatusLine({ context, verboseEnabled: false });
const gatewayFields = () =>
  projectGatewaySessionRunState({ key: parent, now: olderThanCutoff }).fields;
const claimContext = (entry: SubagentRunRecord, ownsContext = true) =>
  claimAgentRunContext(
    entry.runId,
    { sessionKey: entry.childSessionKey },
    { trackOwner: true, ownsContext },
  );
function admittedTask(
  entry: SubagentRunRecord,
  lane: string,
  run: (context: Parameters<typeof getAdmittedRunDelegatedAuthority>[0]) => Promise<void>,
) {
  const admission = prepareSystemAgentRunAdmission(
    getRuntimeConfig(),
    entry.runId,
    "main",
    `liveness-${lane}`,
  );
  return enqueueCommandInLane(`test:liveness-${lane}`, async () => {
    const context = await admission.admit("embedded");
    try {
      await run(context);
    } finally {
      admission.close();
    }
  });
}
const spawnAdmission = (maxChildrenPerAgent: number) =>
  withPreparedSessionCapabilityRead(() =>
    resolveSpawnAdmission({
      cfg: { agents: { defaults: { subagents: { maxChildrenPerAgent } } } },
      requesterSessionKey: parent,
      requesterAgentId: "main",
      targetAgentId: "main",
      configuredAgentIds: ["main"],
    }),
  );

function indexCounts(index = buildSubagentSessionListReadIndex()) {
  return {
    active: index.countActiveDescendantRuns(parent),
    pending: index.countPendingDescendantRuns(parent),
    awaitingSettle: index.hasDescendantRunAwaitingSettle(parent),
  };
}
const idleCounts = { active: 0, pending: 0, awaitingSettle: false };
const liveState = (entry: SubagentRunRecord) => ({
  executor: isSubagentRunLive(entry),
  session: isSubagentSessionRunActive(entry.childSessionKey),
  children: countActiveRunsForSession(parent),
});
const inactive = { executor: false, session: false, children: 0 };

async function relabel(entry: SubagentRunRecord, label: string) {
  await mutateSubagentRuns([entry.runId], (rows) => ({
    value: undefined,
    postimages: new Map([[entry.runId, { ...rows.get(entry.runId)!, label }]]),
  }));
  const updated = subagentRuns.get(entry.runId)!;
  expect(updated).not.toBe(entry);
  return updated;
}

function expectDurable(entry: SubagentRunRecord) {
  subagentRuns.clear();
  expect(loadSubagentRegistryFromSqlite().get(entry.runId)).toMatchObject({
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: parent,
    execution: entry.execution,
  });
}

async function register(id: string, collect = false, expectsCompletionMessage = false) {
  await controlRuns.seed(
    id,
    {
      requesterSessionKey: parent,
      requesterDisplayKey: parent,
      expectsCompletionMessage,
      ...(collect
        ? {
            collect: true,
            queued: true,
            swarmRequesterSessionKey: parent,
            groupId: "liveness-group",
          }
        : {}),
    },
    `${id}-revision`,
  );
  return subagentRuns.get(id)!;
}

it("admits new work at the child cap when finished descendants have suspended delivery", async () => {
  const now = Date.now();
  const completed = Array.from({ length: 5 }, (_, index) => ({
    runId: `completed-orchestrator-${index}`,
    childSessionKey: `agent:main:subagent:completed-orchestrator-${index}`,
    requesterSessionKey: parent,
    requesterAgentId: "main",
    requesterDisplayKey: parent,
    task: "completed orchestration",
    cleanup: "keep" as const,
    createdAt: now - 120_000,
    execution: { status: "terminal" as const, endedAt: now - 60_000 },
  }));
  for (const entry of completed) {
    await addSubagentRunForTests(entry);
    await addSubagentRunForTests({
      ...entry,
      runId: `${entry.runId}-child`,
      childSessionKey: `${entry.childSessionKey}:subagent:child`,
      requesterSessionKey: entry.childSessionKey,
      delivery: { status: "suspended", suspendedAt: now, suspendedReason: "expiry" },
    });
  }
  const admission = () => spawnAdmission(5);

  expect((await admission()).ok).toBe(true);
  expect(countActiveRunsForSession(parent)).toBe(0);
  expect(subagentRuns.size).toBe(10);

  for (const entry of completed) {
    await addSubagentRunForTests({
      ...entry,
      runId: `${entry.runId}-grandchild`,
      childSessionKey: `${entry.childSessionKey}:subagent:grandchild`,
      requesterSessionKey: `${entry.childSessionKey}:subagent:child`,
      createdAt: now,
      execution: { status: "running", startedAt: now },
    });
  }
  expect(await admission()).toMatchObject({
    ok: false,
    governingCap: "subagents.maxChildrenPerAgent",
  });
  expect(countActiveRunsForSession(parent)).toBe(5);
});

it("retains quiet admitted execution in listing, admission count, and requester settlement after two hours", async () => {
  const now = clock();
  const entry = await register("quiet-owned");
  const entered = createDeferred();
  const finish = createDeferred();
  const task = admittedTask(entry, "quiet", async (context) => {
    const authority = getAdmittedRunDelegatedAuthority(context)!;
    expect(
      getAgentRunContextOwnerStatus(entry.runId, authority.claimId, authority.lifecycleGeneration),
    ).toBe("active");
    entered.resolve();
    await finish.promise;
  });
  try {
    await entered.promise;
    now.mockReturnValue(olderThanCutoff);
    expect(getCommandLaneSnapshot("test:liveness-quiet").activeCount).toBe(1);
    const updated = await relabel(entry, "still working");
    expect(isSubagentRunLive(entry)).toBe(true);
    expect(isSubagentRunLive(updated)).toBe(true);
    expect(isSubagentRunLive({ ...updated })).toBe(false);
    expect(sweepStaleRunContexts()).toBe(0);
    await testing.sweepOnceForTests();
    expect(entry.execution.endedAt).toBeUndefined();
    expect(getAgentRunContext(entry.runId)).toBeDefined();
    expect.soft((await spawnAdmission(1)).ok).toBe(false);
    expect.soft(countActiveRunsForSession(parent)).toBe(1);
    expect.soft(await pendingCount()).toBe(1);
    expect.soft(indexCounts()).toMatchObject({ active: 1, awaitingSettle: true });
    expect.soft(isSubagentSessionRunActive(entry.childSessionKey)).toBe(true);
    expect
      .soft(await executionStates([entry]))
      .toEqual([{ runId: entry.runId, execution: "running" }]);
    // A persisted completed sibling already owns an unfrozen settle outbox.
    await addSubagentRunForTests({
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
    await maybeWakeRequesterAfterAllChildrenSettled({
      isSourceCurrent: () => true,
      requesterSessionKey: parent,
      settledEntry: sibling,
      transitionBatch: () => {
        throw new Error("A live sibling cannot transition requester delivery");
      },
      completeBatch,
    });
    expect.soft(completeBatch).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await task;
    expect(liveState(entry)).toEqual(inactive);
    now.mockRestore();
  }
});

it("retains an exact queued collector reservation without calling it executor-live", async () => {
  const now = clock();
  expect(reserve("queued-owned")).toBe(true);
  const entry = await register("queued-owned", true);
  expect(getAgentRunContext(entry.runId)).toBeUndefined();
  expect(listActiveSubagentSessionKeys()).toEqual([entry.childSessionKey]);
  const launch = vi.fn(async () => {});
  activateSwarmRun({
    groupId: "liveness-group",
    runId: entry.runId,
    start: launch,
    onStartFailure: () => true,
  });
  await Promise.resolve();
  const prepared = await readContext();
  expect(await listStates(prepared.runs)).toEqual([{ status: "queued", execution: "queued" }]);
  now.mockReturnValue(olderThanCutoff);
  const agedContext = await readContext();
  expect(resolveSubagentEntryForToken(agedContext.list.view, "1")).toMatchObject({
    entry: { runId: entry.runId },
  });
  expect(statusLine(agedContext)).toContain("Subagents: 1 active");
  expect(isSwarmRunWaitingForCapacity(entry.runId, getSubagentRunRuntimeKey(entry))).toBe(true);
  expect(observe(prepared)).toMatchObject({ state: "queued" });
  const updated = await relabel(entry, "still queued");
  expect(isSubagentRunQueued(entry)).toBe(true);
  expect(isSubagentRunQueued(updated)).toBe(true);
  expect(listActiveSubagentSessionKeys()).toEqual([entry.childSessionKey]);
  expect(observe(prepared)).toMatchObject({ state: "queued" });
  const copied = { ...updated };
  expect(isSubagentRunQueued(copied)).toBe(false);
  expect(observe(prepared, copied)).toMatchObject({ state: "queued" });
  expect(isSubagentRunLive(entry)).toBe(false);
  expect(resolveSubagentSessionStatus(subagentRuns.get(entry.runId))).toBe("queued");
  expect(launch).not.toHaveBeenCalled();
  const index = buildSubagentSessionListReadIndex();
  const projected = index.listDescendantRunsForRequester(parent)[0]!;
  expect(projected).not.toBe(entry);
  expect(projected.runId).toBe(entry.runId);
  expect(isSubagentRunQueued(projected)).toBe(false);
  expect.soft(indexCounts(index)).toEqual({ active: 1, pending: 1, awaitingSettle: true });
  expect.soft(gatewayFields()).toMatchObject({ hasActiveSubagentRun: true });
  expect.soft(countActiveRunsForSession(parent, { collect: true })).toBe(1);
  expect.soft(countActiveRunsForSession(parent, { collect: false })).toBe(0);
  expect.soft(await pendingCount()).toBe(1);
  expect.soft(await listStates([entry])).toEqual([{ status: "queued", execution: "queued" }]);
  const captured = buildSubagentRunReadIndexFromRuns({
    runs: new Map([[projected.runId, projected]]),
    inMemoryRuns: [entry],
    now: olderThanCutoff,
  });
  const hold = holdQueuedSwarmRun(entry.runId);
  try {
    expect(hold?.withdraw()).toBe(true);
    expect(indexCounts(captured)).toEqual(idleCounts);
    expect(isSubagentRunQueued(entry)).toBe(false);
    expect(listActiveSubagentSessionKeys()).toEqual([]);
    expect(observe(prepared)).toMatchObject({ state: "unknown" });
    expect(countActiveRunsForSession(parent, { collect: true })).toBe(0);
    const released = buildSubagentSessionListReadIndex();
    expect(indexCounts(released)).toEqual(idleCounts);
    expect(gatewayFields()).not.toMatchObject({ hasActiveSubagentRun: true });
  } finally {
    await hold?.release();
  }
});

it.each(["last claim", "Gateway retirement"] as const)(
  "drops old execution liveness after %s",
  async (reason) => {
    const now = clock();
    const entry = await register("released-context");
    const preserveRouting = reason === "last claim";
    if (preserveRouting) {
      registerAgentRunContext(entry.runId, { sessionKey: entry.childSessionKey });
    }
    const routingContext = getAgentRunContext(entry.runId);
    const claim = claimContext(entry, !preserveRouting);
    expect(claim).toBeDefined();
    try {
      now.mockReturnValue(olderThanCutoff);
      expect(hasLiveAgentRunContext(entry.runId)).toBe(true);
      expect(isSubagentRunLive(entry)).toBe(true);
      expect(countActiveRunsForSession(parent)).toBe(1);
      if (preserveRouting) {
        releaseAgentRunContext(entry.runId, claim);
        expect(getAgentRunContext(entry.runId)).toBe(routingContext);
      } else {
        rotateAgentRunRegistryLifecycleGeneration();
      }
      expect(hasLiveAgentRunContext(entry.runId)).toBe(false);
      expect(isSubagentRunLive(entry)).toBe(false);
      expect(countActiveRunsForSession(parent)).toBe(0);
      if (preserveRouting) {
        expect.soft(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
        expect.soft(await pendingCount()).toBe(0);
        expect.soft(indexCounts()).toMatchObject({ active: 0, awaitingSettle: false });
      }
    } finally {
      releaseAgentRunContext(entry.runId, claim);
      if (preserveRouting) {
        clearAgentRunContext(entry.runId);
      }
    }
  },
);

it("does not borrow a same-run-ID successor's live claim through a prepared observation", async () => {
  clock();
  const original = await register("live-generation");
  const prepared = await readContext();
  const successor = await register(original.runId);
  const claim = claimContext(successor);
  try {
    expect(successor.generation).toBeGreaterThan(original.generation!);
    expect(hasLiveAgentRunContext(successor.runId)).toBe(true);
    expect(isSubagentRunLive(successor)).toBe(true);
    const current = await readContext();

    expect(observe(prepared)).toMatchObject({ state: "unknown" });
    expect(observe(current)).toMatchObject({ state: "running" });
    for (const [context, state] of [
      [prepared, "unknown"],
      [current, "running"],
    ] as const) {
      expect(await executionStates(context.runs)).toEqual([
        { runId: successor.runId, execution: state },
      ]);
      const status = statusLine(context);
      expect(status).toContain("Subagents: 1 active");
      if (state === "unknown") {
        expect(status).toMatch(/unknown|unavailable/i);
        expect(status).not.toMatch(/\brunning\b/i);
      } else {
        expect(status).toMatch(/\brunning\b/i);
      }
    }
    expect(resolveSubagentSessionStatus(subagentRuns.get(successor.runId))).toBe("running");
    expect(countActiveRunsForSession(parent)).toBe(1);
    expect(await pendingCount()).toBe(1);
  } finally {
    releaseAgentRunContext(successor.runId, claim);
  }
});

it("preserves queued retention across row values while rejecting replaced reservation owners", async () => {
  const now = clock();
  const id = "queue-generation";
  expect(reserve(id)).toBe(true);
  const original = await register(id, true);
  const prepared = await readContext();
  now.mockReturnValue(olderThanCutoff);
  const snapshot = buildSubagentSessionListReadIndex();
  const compact = snapshot.listDescendantRunsForRequester(parent)[0]!;
  expect(isSubagentRunQueued(original)).toBe(true);
  expect(isSubagentRunQueued(compact)).toBe(false);
  expect(indexFor(compact, [{ ...original }]).countActiveDescendantRuns(parent)).toBe(0);

  now.mockReturnValue(start);
  const replacement = await register(id, true);
  now.mockReturnValue(olderThanCutoff);
  expect(replacement).not.toBe(original);
  expect(replacement.generation).toBeGreaterThan(original.generation!);
  expect(isSubagentRunQueued(original)).toBe(false);
  expect(isSubagentRunQueued(replacement)).toBe(false);
  const replaced = await readContext();
  expect(observe(replaced)).toMatchObject({ state: "unknown" });
  expect(snapshot.countActiveDescendantRuns(parent)).toBe(0);
  expect(snapshot.hasDescendantRunAwaitingSettle(parent)).toBe(false);
  expect(buildSubagentSessionListReadIndex().countPendingDescendantRuns(parent)).toBe(0);

  const originalHold = holdQueuedSwarmRun(id);
  let successorHold: ReturnType<typeof holdQueuedSwarmRun>;
  try {
    expect(originalHold?.withdraw()).toBe(true);
    expect(reserve(id)).toBe(true);
    now.mockReturnValue(start);
    const successor = await register(id, true);
    now.mockReturnValue(olderThanCutoff);
    expect(isSubagentRunQueued(successor)).toBe(true);
    expect(observe(prepared)).toMatchObject({ state: "unknown" });
    expect(buildSubagentSessionListReadIndex().countActiveDescendantRuns(parent)).toBe(1);
    expect(indexFor(compact).countActiveDescendantRuns(parent)).toBe(0);
    const current = buildSubagentSessionListReadIndex().listDescendantRunsForRequester(parent)[0]!;
    const otherParent = "agent:main:other-parent";
    expect(
      indexFor({ ...current, requesterSessionKey: otherParent }).countActiveDescendantRuns(
        otherParent,
      ),
    ).toBe(0);
    expect(isSubagentRunQueued(current)).toBe(false);
    expect(isSubagentRunQueued(structuredClone(successor))).toBe(false);
    successorHold = holdQueuedSwarmRun(id);
    expect(successorHold?.withdraw()).toBe(true);
    expect(buildSubagentSessionListReadIndex().countActiveDescendantRuns(parent)).toBe(0);
  } finally {
    await Promise.all([originalHold?.release(), successorHold?.release()]);
  }
});

it("does not keep a recent orphan executor-live after its admitted owner closes", async () => {
  clock();
  const entry = await register("recent-unowned");
  await admittedTask(entry, "owner-loss", async () => {
    expect(isSubagentRunLive(entry)).toBe(true);
  });
  // The executor closed before the registry observed a terminal lifecycle event.
  expect(entry.execution.endedAt).toBeUndefined();
  expect(getAgentRunContext(entry.runId)).toBeUndefined();
  expect(isSubagentRunLive(entry)).toBe(false);
  expect(isSubagentRunQueued(entry)).toBe(false);
  expect(resolveSubagentSessionStatus(subagentRuns.get(entry.runId))).toBe("running");
  expect.soft(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
  expect(countActiveRunsForSession(parent)).toBe(1);
  expect(await executionStates([entry])).toEqual([{ runId: entry.runId, execution: "unknown" }]);
});

it("retains durable suspended completion debt without reporting a live executor or awaiting automatic settlement", async () => {
  const now = clock();
  let entry = await register("suspended-debt", false, true);
  // Restore a terminal result awaiting delivery, then use the real atomic suspension owner.
  await mutateSubagentRuns([entry.runId], (rows) => {
    const draft = structuredClone(rows.get(entry.runId)!);
    draft.execution = {
      ...draft.execution,
      status: "terminal",
      endedAt: start + 1,
      outcome: { status: "ok" },
    };
    draft.completion = { required: true, resultText: "completed result", capturedAt: start + 1 };
    return { value: undefined, postimages: new Map([[draft.runId, draft]]) };
  });
  entry = subagentRuns.get(entry.runId)!;
  now.mockReturnValue(olderThanCutoff);
  expect(await pendingCount()).toBe(1);
  expect(buildSubagentSessionListReadIndex().hasDescendantRunAwaitingSettle(parent)).toBe(true);
  expect(
    await blockSubagentCompletionDelivery({
      subagent: entry,
      reason: "delivery budget exhausted",
      suspendedReason: "expiry",
    }),
  ).toBe(true);
  const suspended = subagentRuns.get(entry.runId)!;
  expect(suspended.delivery?.status).toBe("suspended");
  expect(await pendingCount()).toBe(1);
  expect(buildSubagentSessionListReadIndex().hasDescendantRunAwaitingSettle(parent)).toBe(false);
  expect(liveState(suspended)).toEqual(inactive);
  expectDurable(entry);
});

it("keeps a restart-preserved native record distinct from an executor", async () => {
  const now = clock();
  const entry = await register("interrupted-task");
  const result = await preserveSubagentRunForRestart({
    entry,
    terminal: { reason: "cancelled", status: "error", stopReason: "restart", endedAt: start + 1 },
    runs: subagentRuns,
  });
  expect(result.preserved).toBe(true);
  const interrupted = subagentRuns.get(entry.runId)!;
  now.mockReturnValue(olderThanCutoff);
  expect(interrupted.execution.status).toBe("interrupted");
  expect(interrupted.execution.endedAt).toBeUndefined();
  expect(isSubagentRunLive(interrupted)).toBe(false);
  expect(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
  expectDurable(interrupted);
});

it("makes an admitted child inactive when termination is recorded", async () => {
  const entry = await register("terminated-owner");
  await admittedTask(entry, "termination", async () => {
    expect(isSubagentSessionRunActive(entry.childSessionKey)).toBe(true);
    expect(
      await markSubagentRunTerminated({
        childSessionKey: entry.childSessionKey,
        reason: "manual kill",
      }),
    ).toBe(1);
    expect(isSubagentSessionRunActive(entry.childSessionKey)).toBe(false);
  });
});
