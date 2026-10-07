// Subagent registry query tests cover liveness, descendant counting, requester
// lookup, and stale-row handling for in-memory run snapshots.
import { describe, expect, it, vi } from "vitest";
import { claimAgentRunContext, releaseAgentRunContext } from "../../../infra/agent-run-registry.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  buildSubagentRunReadIndexFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  listRunsForRequesterFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;

function makeRun(overrides: Partial<SubagentRunRecordOverrides>): SubagentRunRecord {
  const runId = overrides.runId ?? "run-default";
  const childSessionKey = overrides.childSessionKey ?? `agent:main:subagent:${runId}`;
  const requesterSessionKey = overrides.requesterSessionKey ?? "agent:main:main";
  return createSubagentRunRecord({
    runId,
    childSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: "test task",
    cleanup: "keep",
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
  });
}

function toRunMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord> {
  return new Map(runs.map((run) => [run.runId, run]));
}

describe("subagent registry query regressions", () => {
  it("patches one sibling without reading others and preserves group order after removal", () => {
    let unrelatedReads = 0;
    const first = {
      ...makeRun({
        runId: "first",
        collect: true,
        groupId: "group",
        swarmRequesterSessionKey: "parent",
      }),
      get runId() {
        unrelatedReads++;
        return "first";
      },
    };
    const middle = makeRun({ ...first, runId: "middle", childSessionKey: "middle" });
    const last = makeRun({ ...first, runId: "last", childSessionKey: "last" });
    let index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap([first, middle, last]) });
    unrelatedReads = 0;
    const updated = { ...last, cleanupCompletedAt: 100 };
    index = index.patch(toRunMap([updated]), new Map());
    expect(unrelatedReads).toBe(0);
    expect(index.getDisplaySubagentRun("last")).toBe(updated);

    index = index.patch(new Map([[middle.runId, undefined]]), new Map());
    const replacement = { ...last, cleanupCompletedAt: 200 };
    index = index.patch(toRunMap([replacement]), new Map());
    expect(index.runsByControllerSessionKey.get(first.requesterSessionKey)).toEqual([
      first,
      replacement,
    ]);
    expect(index.swarmRunsByRequesterSessionKey.get("parent")).toEqual([first, replacement]);
    index = index.patch(toRunMap([middle]), new Map());
    const expectedOrder = [first, replacement, middle];
    expect(index.runsByControllerSessionKey.get(first.requesterSessionKey)).toEqual(expectedOrder);
    expect(index.swarmRunsByRequesterSessionKey.get("parent")).toEqual(expectedOrder);
  });

  it("preserves complete snapshot inputs and exact memory winners after the source changes", () => {
    const ungrouped = makeRun({ runId: "ungrouped", requesterSessionKey: "", endedAt: 50 });
    const older = makeRun({ runId: "older", createdAt: 10, endedAt: 15 });
    const winner = makeRun({
      runId: "winner",
      childSessionKey: older.childSessionKey,
      createdAt: 20,
      endedAt: 30,
    });
    const runs = toRunMap([ungrouped, structuredClone(winner)]);
    const memory = toRunMap([older, winner, ungrouped]);
    using writes = vi.spyOn(runs, "set");
    const index = buildSubagentRunReadIndexFromRuns({
      runs,
      inMemoryRuns: memory.values(),
      now: 100,
    });
    memory.clear();
    expect(index.inputs).toBeDefined();
    expect(index.inputs.runs).toBe(runs);
    expect(index.inputs.runs.get(ungrouped.runId)).toBe(ungrouped);
    expect([...index.inputs.inMemoryRuns]).toHaveLength(2);
    expect([...index.inputs.inMemoryRuns][0]).toBe(winner);
    const candidates = index.runsByChildSessionKey.get(winner.childSessionKey);
    expect(candidates).toHaveLength(2);
    expect(candidates?.[0]).toBe(runs.get(winner.runId));
    expect(candidates?.[1]).toBe(winner);
    expect(index.runsByChildSessionKey.get(ungrouped.childSessionKey)).toEqual([ungrouped]);
    expect(index.atTime(200).runsByChildSessionKey).toBe(index.runsByChildSessionKey);
    expect(index.atTime(200).revision).toBe(index.revision);
    const replay = buildSubagentRunReadIndexFromRuns({ ...index.inputs, now: 200 });
    expect(replay.getDisplaySubagentRun(winner.childSessionKey)).toBe(winner);
    expect(replay.getDisplaySubagentRun(ungrouped.childSessionKey)).toBe(ungrouped);
    expect(writes).not.toHaveBeenCalled();
  });

  it("patches moved memberships and reveals retained generations when a live owner retires", () => {
    const older = makeRun({
      runId: "older",
      childSessionKey: "child",
      requesterSessionKey: "parent",
      generation: 1,
    });
    const latest = makeRun({
      ...older,
      runId: "latest",
      generation: 2,
      collect: true,
      groupId: "group",
      swarmRequesterSessionKey: "parent",
    });
    const runs = toRunMap([structuredClone(older), structuredClone(latest)]);
    let index = buildSubagentRunReadIndexFromRuns({ runs, inMemoryRuns: [older, latest] });
    const revision = index.revision;
    const listed = index.listDescendantRunsForRequester("parent");
    expect(listed.map((run) => run.runId)).toEqual(["latest"]);
    listed.length = 0;
    expect(
      index
        .atTime(100)
        .listDescendantRunsForRequester("parent")
        .map((run) => run.runId),
    ).toEqual(["latest"]);
    expect(index.listDescendantRunsForRequester("requester")).toEqual([]);
    latest.childSessionKey = "moved";
    latest.controllerSessionKey = "controller";
    latest.requesterSessionKey = "requester";
    latest.swarmRequesterSessionKey = "swarm";
    index = index.patch(toRunMap([structuredClone(latest)]), toRunMap([latest]));
    expect(index.revision).not.toBe(revision);
    expect(index.getDisplaySubagentRun("child")).toBe(older);
    expect(index.getDisplaySubagentRun("moved")).toBe(latest);
    const replay = buildSubagentRunReadIndexFromRuns(index.inputs);
    expect(replay.getDisplaySubagentRun("child")).toBe(older);
    expect(replay.getDisplaySubagentRun("moved")).toBe(latest);
    expect(index.runsByControllerSessionKey.get("parent")?.map((run) => run.runId)).toEqual([
      "older",
    ]);
    expect(index.runsByControllerSessionKey.get("controller")?.map((run) => run.runId)).toEqual([
      "latest",
    ]);
    expect(index.swarmRunsByRequesterSessionKey.has("parent")).toBe(false);
    expect(index.swarmRunsByRequesterSessionKey.get("swarm")?.map((run) => run.runId)).toEqual([
      "latest",
    ]);
    expect(index.listDescendantRunsForRequester("parent").map((run) => run.runId)).toEqual([
      "older",
    ]);
    expect(index.listDescendantRunsForRequester("requester").map((run) => run.runId)).toEqual([
      "latest",
    ]);
    index = index.patch(new Map(), new Map([[latest.runId, undefined]]));
    expect(index.getDisplaySubagentRun("moved")).toBe(runs.get("latest"));
    expect(buildSubagentRunReadIndexFromRuns(index.inputs).getDisplaySubagentRun("moved")).toBe(
      runs.get("latest"),
    );
    index = index.patch(new Map([[latest.runId, undefined]]), new Map());
    expect(index.getDisplaySubagentRun("moved")).toBeNull();
    expect(index.runsByControllerSessionKey.has("controller")).toBe(false);
    expect(index.swarmRunsByRequesterSessionKey.has("swarm")).toBe(false);
    expect(index.listDescendantRunsForRequester("requester")).toEqual([]);
  });

  it("preserves captured display classification while descendant queries see released owners", () => {
    const now = Date.now();
    const root = "agent:main:captured-index";
    const running = makeRun({
      runId: "captured-display",
      requesterSessionKey: root,
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
    });
    const ended = makeRun({
      runId: "captured-ended",
      requesterSessionKey: root,
      childSessionKey: running.childSessionKey,
      createdAt: now - 100,
      endedAt: now - 10,
    });
    const sibling = makeRun({
      runId: "captured-sibling",
      requesterSessionKey: root,
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
    });
    const claims = [running, sibling].map(
      (entry) =>
        [
          entry.runId,
          claimAgentRunContext(
            entry.runId,
            { sessionKey: entry.childSessionKey },
            { trackOwner: true, ownsContext: true },
          ),
        ] as const,
    );
    try {
      subagentRuns.set(running.runId, running);
      subagentRuns.set(sibling.runId, sibling);
      const params = { runs: toRunMap([running, ended, sibling]), now };
      const index = buildSubagentRunReadIndexFromRuns(params);
      for (const [id, claim] of claims) {
        releaseAgentRunContext(id, claim);
      }
      expect(index.getDisplaySubagentRun(running.childSessionKey)).toBe(running);
      expect(index.countActiveDescendantRuns(root)).toBe(0);
      expect(index.atTime(now).getDisplaySubagentRun(running.childSessionKey)).toBe(ended);
      expect(index.getDisplaySubagentRun(running.childSessionKey)).toBe(running);
    } finally {
      for (const [id, claim] of claims) {
        releaseAgentRunContext(id, claim);
        subagentRuns.delete(id);
      }
    }
  });

  it.each(["generation", "staleness"] as const)("selects the current child by %s", (kind) => {
    const now = Date.now();
    const old = makeRun({
      runId: "old",
      generation: 1,
      createdAt: kind === "generation" ? 100 : now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      ...(kind === "generation" ? { endedAt: 100 } : {}),
    });
    const current = makeRun({
      runId: "current",
      childSessionKey: old.childSessionKey,
      requesterSessionKey: "agent:main:new-parent",
      generation: kind === "generation" ? 2 : 1,
      createdAt: kind === "generation" ? 100 : now - 60_000,
      ...(kind === "generation"
        ? { startedAt: 100 }
        : { endedAt: now - 1_000, cleanupCompletedAt: now }),
    });
    const runs = toRunMap([old, current]);
    expect(getLatestSubagentRunByChildSessionKeyFromRuns(runs, old.childSessionKey)).toBe(current);
    expect(getSubagentRunByChildSessionKeyFromRuns(runs, old.childSessionKey)).toBe(current);
  });

  it.each([false, true])("excludes stale children from counts (fresh child ended: %s)", (ended) => {
    const now = Date.now();
    const stale = makeRun({ runId: "stale", createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1 });
    const fresh = makeRun({
      runId: "fresh",
      createdAt: now - 60_000,
      ...(ended ? { endedAt: now - 1_000 } : {}),
    });
    const runs = toRunMap([stale, fresh]);
    expect(countActiveRunsForSessionFromRuns(runs, fresh.requesterSessionKey)).toBe(ended ? 0 : 1);
    expect(countPendingDescendantRunsFromRuns(runs, fresh.requesterSessionKey)).toBe(1);
  });

  it("counts collectors against the spawning owner and excludes them from announce admission", () => {
    const owner = "agent:main:telegram:default:direct:456";
    const entry = makeRun({
      runId: "collector",
      controllerSessionKey: "agent:main:main",
      collect: true,
      swarmRequesterSessionKey: owner,
      createdAt: Date.now(),
      execution: { status: "queued" },
    });
    const runs = toRunMap([entry]);
    expect(countActiveRunsForSessionFromRuns(runs, owner)).toBe(1);
    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(0);
    expect(countActiveRunsForSessionFromRuns(runs, owner, { collect: false })).toBe(0);
  });

  it.each(["stale", "ended"] as const)(
    "keeps a %s orchestrator active until descendant cleanup",
    (kind) => {
      const now = Date.now();
      const parent = makeRun({
        runId: "parent",
        createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
        ...(kind === "ended" ? { endedAt: now - 2_000 } : {}),
      });
      const child = makeRun({
        runId: "child",
        requesterSessionKey: parent.childSessionKey,
        createdAt: now - 60_000,
      });
      const runs = toRunMap([parent, child]);
      expect(countActiveRunsForSessionFromRuns(runs, parent.requesterSessionKey)).toBe(1);
      runs.set(child.runId, {
        ...child,
        execution: { ...child.execution, status: "terminal", endedAt: now - 1_000 },
        cleanupCompletedAt: now,
      });
      expect(countActiveRunsForSessionFromRuns(runs, parent.requesterSessionKey)).toBe(0);
    },
  );

  it("counts nested pending cleanup until every descendant has settled", () => {
    const middle = makeRun({ runId: "middle", endedAt: 200 });
    const done = makeRun({
      runId: "done",
      requesterSessionKey: middle.childSessionKey,
      endedAt: 210,
      cleanupCompletedAt: 215,
    });
    const pending = makeRun({
      runId: "pending",
      requesterSessionKey: middle.childSessionKey,
      endedAt: 211,
    });
    const runs = toRunMap([middle, done, pending]);
    expect(countPendingDescendantRunsFromRuns(runs, middle.requesterSessionKey)).toBe(2);
    expect(countPendingDescendantRunsFromRuns(runs, middle.childSessionKey)).toBe(1);
    runs.set(middle.runId, { ...middle, cleanupCompletedAt: 220 });
    runs.set(pending.runId, { ...pending, cleanupCompletedAt: 221 });
    expect(countPendingDescendantRunsFromRuns(runs, middle.requesterSessionKey)).toBe(0);
    expect(countPendingDescendantRunsFromRuns(runs, middle.childSessionKey)).toBe(0);
  });

  it("deduplicates restarted descendants for pending and active counts", () => {
    const old = makeRun({ runId: "old", createdAt: 100, startedAt: 100, endedAt: 150 });
    const current = makeRun({
      runId: "current",
      childSessionKey: old.childSessionKey,
      createdAt: 200,
      startedAt: 200,
    });
    const leaf = makeRun({
      runId: "leaf",
      requesterSessionKey: current.childSessionKey,
      createdAt: 210,
      startedAt: 210,
    });
    const runs = toRunMap([old, current, leaf]);
    expect(countPendingDescendantRunsFromRuns(runs, current.requesterSessionKey)).toBe(2);
    expect(countActiveRunsForSessionFromRuns(runs, current.requesterSessionKey)).toBe(1);
  });

  it("uses the admission snapshot time for descendants at the stale boundary", () => {
    const capturedAt = Date.now();
    const parent = makeRun({ runId: "ended-parent", endedAt: capturedAt - 1 });
    const child = makeRun({
      runId: "boundary-child",
      requesterSessionKey: parent.childSessionKey,
      createdAt: capturedAt - STALE_UNENDED_SUBAGENT_RUN_MS,
      startedAt: capturedAt - STALE_UNENDED_SUBAGENT_RUN_MS,
    });
    const runs = toRunMap([parent, child]);
    const index = buildSubagentRunReadIndexFromRuns({ runs, now: capturedAt });
    expect(index.countActiveDescendantRuns(parent.childSessionKey)).toBe(1);
    expect(index.atTime(capturedAt + 1).countActiveDescendantRuns(parent.childSessionKey)).toBe(0);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(capturedAt)
      .mockReturnValue(capturedAt + 1);
    try {
      expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves breadth-first cycle traversal and refreshes a cached tree after a generation moves", () => {
    const child = makeRun({
      runId: "child",
      childSessionKey: "child",
      requesterSessionKey: "parent",
      generation: 1,
    });
    const sibling = makeRun({
      runId: "sibling",
      childSessionKey: "sibling",
      requesterSessionKey: "parent",
    });
    const parent = makeRun({
      runId: "parent",
      childSessionKey: "parent",
      requesterSessionKey: "child",
    });
    let index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap([child, sibling, parent]) });
    for (const view of [index, index.atTime(100)]) {
      expect(view.listDescendantRunsForRequester("parent").map((run) => run.runId)).toEqual([
        "child",
        "sibling",
        "parent",
      ]);
      expect(view.countPendingDescendantRuns("parent")).toBe(3);
    }
    const successor = makeRun({
      ...child,
      runId: "successor",
      requesterSessionKey: "new-parent",
      generation: 2,
    });
    index = index.patch(toRunMap([successor]), new Map());
    expect(index.listDescendantRunsForRequester("parent").map((run) => run.runId)).toEqual([
      "sibling",
    ]);
    expect(index.listDescendantRunsForRequester("new-parent").map((run) => run.runId)).toEqual([
      "successor",
      "parent",
      "sibling",
    ]);
    expect(index.countPendingDescendantRuns("parent")).toBe(1);
    expect(index.countPendingDescendantRuns("new-parent")).toBe(3);
  });

  it("scopes direct children to the requester run window", () => {
    const parent = makeRun({ runId: "parent", createdAt: 200, startedAt: 200, endedAt: 260 });
    const old = makeRun({
      runId: "old",
      childSessionKey: parent.childSessionKey,
      createdAt: 100,
      startedAt: 100,
      endedAt: 150,
    });
    const runs = toRunMap([
      old,
      parent,
      ...[130, 210, 220, 270].map((createdAt) =>
        makeRun({
          runId: `child-${createdAt}`,
          requesterSessionKey: parent.childSessionKey,
          createdAt,
        }),
      ),
    ]);
    expect(
      listRunsForRequesterFromRuns(runs, parent.childSessionKey, { requesterRunId: parent.runId })
        .map((entry) => entry.runId)
        .toSorted(),
    ).toEqual(["child-210", "child-220"]);
  });

  it.each(["run", "session"] as const)(
    "gates late announces after %s-mode parent cleanup",
    (spawnMode) => {
      const parent = makeRun({ runId: "parent", createdAt: 2, endedAt: 100, spawnMode });
      const old = makeRun({
        runId: "old",
        childSessionKey: parent.childSessionKey,
        createdAt: 1,
        endedAt: 10,
        cleanupCompletedAt: 11,
        spawnMode,
      });
      const children = ["one", "two"].map((runId, index) =>
        makeRun({
          runId,
          requesterSessionKey: parent.childSessionKey,
          createdAt: 3 + index,
          endedAt: 110 + index,
        }),
      );
      const runs = toRunMap([old, parent, ...children]);
      const ignored = () =>
        shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, parent.childSessionKey);
      for (const child of children) {
        expect(
          getLatestSubagentRunByChildSessionKeyFromRuns(runs, child.childSessionKey)
            ?.requesterSessionKey,
        ).toBe(parent.childSessionKey);
      }
      expect(ignored()).toBe(false);
      for (const child of children) {
        runs.set(child.runId, { ...child, cleanupCompletedAt: 120 });
      }
      const last = makeRun({
        runId: "last",
        requesterSessionKey: parent.childSessionKey,
        createdAt: 5,
      });
      runs.set(last.runId, last);
      expect(
        getLatestSubagentRunByChildSessionKeyFromRuns(runs, last.childSessionKey)
          ?.requesterSessionKey,
      ).toBe(parent.childSessionKey);
      expect(ignored()).toBe(false);
      runs.set(last.runId, {
        ...last,
        execution: { ...last.execution, status: "terminal", endedAt: 122 },
        cleanupCompletedAt: 123,
      });
      runs.set(parent.runId, { ...parent, cleanupCompletedAt: 130 });
      expect(ignored()).toBe(spawnMode === "run");
    },
  );
});

describe("hasDescendantRunAwaitingSettleFromRuns", () => {
  const requester = "agent:main:main";

  it.each([
    { name: "ended before the batch", endOffset: -1, pending: false },
    { name: "ended at the batch boundary", endOffset: 0, pending: true },
    { name: "ended during the batch", endOffset: 1, pending: true },
    { name: "still executing", endOffset: undefined, pending: true },
  ])("scopes $name without pruning descendants of an old parent", ({ endOffset, pending }) => {
    const batchCreatedAt = Date.now() - 1_000;
    const parent = makeRun({
      runId: "old-parent",
      requesterSessionKey: requester,
      createdAt: batchCreatedAt - 3_000,
      endedAt: batchCreatedAt - 2_000,
    });
    const descendant = makeRun({
      runId: "descendant",
      requesterSessionKey: parent.childSessionKey,
      createdAt: batchCreatedAt - 2_500,
      startedAt: batchCreatedAt - 2_500,
      ...(endOffset !== undefined ? { endedAt: batchCreatedAt + endOffset } : {}),
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
    });
    const runs = toRunMap([parent, descendant]);

    expect(
      hasDescendantRunAwaitingSettleFromRuns(
        runs,
        requester,
        undefined,
        undefined,
        undefined,
        batchCreatedAt,
      ),
    ).toBe(pending);
    expect(countPendingDescendantRunsFromRuns(runs, requester)).toBe(2);
  });

  it.each([
    { name: "running", ended: false, delivery: undefined, cleanup: undefined, pending: true },
    {
      name: "awaiting cleanup",
      ended: true,
      delivery: undefined,
      cleanup: undefined,
      pending: true,
    },
    { name: "cleaned", ended: true, delivery: undefined, cleanup: 9_000, pending: false },
    {
      name: "suspended",
      ended: true,
      delivery: { status: "suspended", suspendedAt: 9_000 },
      cleanup: undefined,
      pending: false,
    },
    {
      name: "queued delivery",
      ended: true,
      delivery: { status: "in_progress", disposition: "session_queued" },
      cleanup: undefined,
      pending: true,
    },
    {
      name: "delivered",
      ended: true,
      delivery: { status: "delivered", disposition: "delivered" },
      cleanup: undefined,
      pending: false,
    },
    {
      name: "dismissed",
      ended: true,
      delivery: { status: "discarded", disposition: "intentional_non_delivery" },
      cleanup: undefined,
      pending: false,
    },
  ] as const)(
    "settles $name descendants independently of pending cleanup",
    ({ ended, delivery, cleanup, pending }) => {
      const entry = makeRun({
        runId: "child",
        createdAt: 1_000,
        ...(ended ? { endedAt: 8_000 } : {}),
        cleanupCompletedAt: cleanup,
        expectsCompletionMessage: true,
        ...(delivery ? { delivery } : {}),
      });
      const runs = toRunMap([entry]);
      expect(hasDescendantRunAwaitingSettleFromRuns(runs, requester)).toBe(pending);
      expect(countPendingDescendantRunsFromRuns(runs, requester)).toBe(cleanup ? 0 : 1);
      expect(hasDescendantRunAwaitingSettleFromRuns(runs, requester, entry.runId)).toBe(false);
    },
  );

  it("visits unsettled grandchildren below an excluded settled parent", () => {
    const parent = makeRun({ runId: "parent", endedAt: 5_000, cleanupCompletedAt: 6_000 });
    const leaf = makeRun({
      runId: "leaf",
      requesterSessionKey: parent.childSessionKey,
      createdAt: 7_000,
    });
    expect(
      hasDescendantRunAwaitingSettleFromRuns(toRunMap([parent, leaf]), requester, parent.runId),
    ).toBe(true);
  });
});
