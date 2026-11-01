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
  listRunsForRequesterFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;

function makeRun(
  runId: string,
  overrides: Partial<SubagentRunRecordOverrides> = {},
): SubagentRunRecord {
  const childSessionKey = overrides.childSessionKey ?? `agent:main:subagent:${runId}`;
  const requesterSessionKey = overrides.requesterSessionKey ?? "agent:main:main";
  return createSubagentRunRecord({
    childSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: "test task",
    cleanup: "keep",
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
    runId,
  });
}

function toRunMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord> {
  return new Map(runs.map((run) => [run.runId, run]));
}

const runIds = (runs: readonly { runId: string }[] | undefined) => runs?.map((run) => run.runId);
const descendants = (index: ReturnType<typeof buildSubagentRunReadIndexFromRuns>, root: string) =>
  runIds(index.listDescendantRunsForRequester(root));

describe("subagent registry query regressions", () => {
  it("counts prepared descendants without allocating array iterators", () => {
    const parent = makeRun("parent", { endedAt: 100 });
    const child = makeRun("child", {
      requesterSessionKey: parent.childSessionKey,
      endedAt: 100,
    });
    const index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap([parent, child]) });
    const root = parent.requesterSessionKey;
    index.listDescendantRunsForRequester(root);
    const iterate = Array.prototype[Symbol.iterator];
    let iterations = 0;
    // eslint-disable-next-line no-extend-native -- Measure native iterator work; restore synchronously below.
    Array.prototype[Symbol.iterator] = function () {
      iterations++;
      return iterate.call(this);
    };
    let active: number;
    let pending: number;
    try {
      active = index.countActiveDescendantRuns(root);
      pending = index.countPendingDescendantRuns(root);
    } finally {
      // eslint-disable-next-line no-extend-native -- Restore the instrumented native iterator.
      Array.prototype[Symbol.iterator] = iterate;
    }
    expect(active).toBe(0);
    expect(pending).toBe(2);
    expect(iterations).toBe(0);
    using clears = vi.spyOn(Set.prototype, "clear");
    for (let window = 0; window < 10; window++) {
      expect(index.atTime(Date.now()).countActiveDescendantRuns(root)).toBe(0);
    }
    // Clearing an empty dirty set replaces its backing store on every warm read.
    expect(clears).not.toHaveBeenCalled();
  });

  it.each([50, 150, 500])("repairs active descendants without reading %i siblings", (size) => {
    const now = Date.UTC(2026, 9, 25);
    const children = Array.from({ length: size }, (_, i) =>
      makeRun(`child-${i}`, { createdAt: now, endedAt: now }),
    );
    const child = children[0]!;
    const root = child.requesterSessionKey;
    let index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap(children), now });
    expect(index.countActiveDescendantRuns(root)).toBe(0);
    using reads = vi.spyOn(index.latestRunsByChildSessionKey, "get");
    for (let event = 1; event <= 20; event++) {
      const changed = {
        ...child,
        execution: { ...child.execution, endedAt: event % 2 ? undefined : now },
      };
      index = index.patch(toRunMap([changed]), new Map(), now + event);
      reads.mockClear();
      expect(index.countActiveDescendantRuns(root)).toBe(event % 2);
      expect(index.atTime(now + event + 1).countActiveDescendantRuns(root)).toBe(event % 2);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
      expect(index.hasUnendedRuns(root)).toBe(event % 2 === 1);
      expect(index.hasUnendedRuns(child.childSessionKey)).toBe(event % 2 === 1);
    }
  });

  it.each([undefined, 0, -1, Number.NaN, Infinity, -Infinity])(
    "distinguishes active descendants from pending results with endedAt=%s",
    (endedAt) => {
      const now = Date.UTC(2026, 9, 25);
      const child = makeRun("run-default", {
        createdAt: now,
        execution: { status: "terminal", startedAt: now, endedAt },
      });
      const index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap([child]), now });
      const active = endedAt === undefined || !Number.isFinite(endedAt) ? 1 : 0;
      expect(index.countActiveDescendantRuns(child.requesterSessionKey)).toBe(active);
      expect(index.countPendingDescendantRuns(child.requesterSessionKey)).toBe(1);
      expect(index.countActiveDescendantRuns(child.requesterSessionKey)).toBe(active);
    },
  );

  it("keeps cached parent groups current across status, generation, move, insert and removal churn", () => {
    const now = Date.UTC(2026, 9, 25);
    const roots = ["parent-a", "parent-b", "child-0", "child-1"];
    const originals = Array.from({ length: 12 }, (_, index) =>
      makeRun(`run-${index}`, {
        childSessionKey: `child-${Math.floor(index / 2)}`,
        requesterSessionKey: roots[Math.floor(index / 2) % roots.length]!,
        generation: index % 2,
        createdAt: now,
        execution: { status: "running", startedAt: now },
      }),
    );
    const expected = toRunMap(originals);
    let index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap(originals), now });
    let seed = 203;
    for (let step = 0; step < 100; step++) {
      // Prime both groups before every mutation, including an empty parent.
      for (const root of roots) {
        index.listDescendantRunsForRequester(root);
      }
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const original = originals[seed % originals.length]!;
      const previous = expected.get(original.runId) ?? original;
      const operation = (seed >>> 16) % 4;
      const next =
        operation === 0
          ? undefined
          : {
              ...previous,
              ...(operation === 1 ? { requesterSessionKey: roots[step % roots.length]! } : {}),
              ...(operation === 2 ? { generation: step + 2 } : {}),
              execution:
                step % 2
                  ? { status: "running" as const, startedAt: now }
                  : { status: "terminal" as const, endedAt: now },
            };
      index = index.patch(new Map([[original.runId, next]]), new Map(), now);
      if (next) {
        expected.set(original.runId, next);
      } else {
        expected.delete(original.runId);
      }
      const latest = new Map<string, SubagentRunRecord>();
      for (const row of [...expected.values()].toSorted(
        (left, right) =>
          (left.generation ?? 0) - (right.generation ?? 0) ||
          left.createdAt - right.createdAt ||
          left.runId.localeCompare(right.runId),
      )) {
        latest.set(row.childSessionKey, row);
      }
      for (const root of roots) {
        const rows: SubagentRunRecord[] = [];
        const visited = new Set([root]);
        const pending = [root];
        for (const parent of pending) {
          for (const row of latest.values()) {
            if (row.requesterSessionKey !== parent) {
              continue;
            }
            rows.push(row);
            if (!visited.has(row.childSessionKey)) {
              visited.add(row.childSessionKey);
              pending.push(row.childSessionKey);
            }
          }
        }
        const byId = (left: SubagentRunRecord, right: SubagentRunRecord) =>
          left.runId.localeCompare(right.runId);
        expect(index.listDescendantRunsForRequester(root).toSorted(byId)).toEqual(
          rows.toSorted(byId),
        );
        expect(index.countActiveDescendantRuns(root)).toBe(
          rows.filter((row) => row.execution.endedAt === undefined).length,
        );
      }
    }
  });

  it.each(["absent", "same object", "distinct object"] as const)(
    "keeps child snapshots independent across patches with %s memory",
    (kind) => {
      const first = makeRun("first", { childSessionKey: "child", generation: 1 });
      const second = makeRun("second", { childSessionKey: "child", generation: 2 });
      const memory =
        kind === "absent" ? undefined : kind === "same object" ? second : { ...second };
      using copies = vi.spyOn(Array.prototype, "slice");
      let index = buildSubagentRunReadIndexFromRuns({
        runs: toRunMap([first, second]),
        inMemoryRuns: memory ? [memory, memory] : [],
      });
      const initialCopies = copies.mock.calls.length;
      copies.mockRestore();
      expect(initialCopies).toBe(0);
      const captured = index.runsByChildSessionKey.get("child");
      const expected = kind === "distinct object" ? [first, second, memory] : [first, second];
      expect(captured).toEqual(expected);
      if (memory) {
        expect(captured?.filter((row) => row === memory)).toHaveLength(1);
      }
      const replacement = { ...first, cleanupCompletedAt: 100 };
      index = index.patch(toRunMap([replacement]), new Map());
      expect(index.runsByChildSessionKey.get("child")?.[0]).toBe(replacement);
      index = index.patch(new Map([[second.runId, undefined]]), new Map());
      expect(index.runsByChildSessionKey.get("child")).toEqual(
        memory ? [replacement, memory] : [replacement],
      );
      expect(captured).toEqual(expected);
      expect(captured?.[0]).toBe(first);
    },
  );

  it.each([false, true])(
    "keeps retired child snapshots after a memory-only update (%s)",
    (same) => {
      const first = makeRun("first", { childSessionKey: "child" });
      let index = buildSubagentRunReadIndexFromRuns({
        runs: toRunMap([first]),
        inMemoryRuns: same ? [first] : [],
      });
      const captured = index.runsByChildSessionKey.get("child");
      const memory = { ...first, cleanupCompletedAt: 50 };
      index = index.patch(new Map(), toRunMap([memory]));
      expect(index.runsByChildSessionKey.get("child")).toEqual([first, memory]);
      const replacement = { ...first, cleanupCompletedAt: 100 };
      index = index.patch(toRunMap([replacement]), new Map());
      index = index.patch(new Map([[first.runId, undefined]]), new Map());
      expect(index.runsByChildSessionKey.get("child")).toEqual([memory]);
      expect(captured).toEqual([first]);
    },
  );

  it("patches one sibling without reading others and preserves group order after removal", () => {
    let unrelatedReads = 0;
    const first = {
      ...makeRun("first", {
        collect: true,
        groupId: "group",
        swarmRequesterSessionKey: "parent",
      }),
      get runId() {
        unrelatedReads++;
        return "first";
      },
    };
    const middle = makeRun("middle", { ...first, childSessionKey: "middle" });
    const last = makeRun("last", { ...first, childSessionKey: "last" });
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

  it("patches moved memberships and reveals retained generations when a live owner retires", () => {
    const older = makeRun("older", {
      childSessionKey: "child",
      requesterSessionKey: "parent",
      generation: 1,
    });
    const latest = makeRun("latest", {
      ...older,
      generation: 2,
      collect: true,
      groupId: "group",
      swarmRequesterSessionKey: "parent",
    });
    const runs = toRunMap([structuredClone(older), structuredClone(latest)]);
    let index = buildSubagentRunReadIndexFromRuns({ runs, inMemoryRuns: [older, latest] });
    const revision = index.revision;
    const listed = index.listDescendantRunsForRequester("parent");
    expect(runIds(listed)).toEqual(["latest"]);
    listed.length = 0;
    expect(descendants(index.atTime(100), "parent")).toEqual(["latest"]);
    expect(index.listDescendantRunsForRequester("requester")).toEqual([]);
    latest.childSessionKey = "moved";
    latest.controllerSessionKey = "controller";
    latest.requesterSessionKey = "requester";
    latest.swarmRequesterSessionKey = "swarm";
    index = index.patch(toRunMap([structuredClone(latest)]), toRunMap([latest]));
    expect(index.revision).not.toBe(revision);
    const replay = buildSubagentRunReadIndexFromRuns(index.inputs);
    for (const view of [index, replay]) {
      expect(view.getDisplaySubagentRun("child")).toBe(older);
      expect(view.getDisplaySubagentRun("moved")).toBe(latest);
    }
    expect(runIds(index.runsByControllerSessionKey.get("parent"))).toEqual(["older"]);
    expect(runIds(index.runsByControllerSessionKey.get("controller"))).toEqual(["latest"]);
    expect(index.swarmRunsByRequesterSessionKey.has("parent")).toBe(false);
    expect(runIds(index.swarmRunsByRequesterSessionKey.get("swarm"))).toEqual(["latest"]);
    expect(descendants(index, "parent")).toEqual(["older"]);
    expect(descendants(index, "requester")).toEqual(["latest"]);
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
    const live = ["captured-display", "captured-sibling"].map((id) =>
      makeRun(id, {
        requesterSessionKey: root,
        createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
        startedAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      }),
    );
    const running = live[0]!;
    const ended = makeRun("captured-ended", {
      requesterSessionKey: root,
      childSessionKey: running.childSessionKey,
      createdAt: now - 100,
      endedAt: now - 10,
    });
    const claims = live.map((entry) =>
      claimAgentRunContext(
        entry.runId,
        { sessionKey: entry.childSessionKey },
        { trackOwner: true, ownsContext: true },
      ),
    );
    const release = () =>
      live.forEach((entry, i) => releaseAgentRunContext(entry.runId, claims[i]));
    try {
      for (const entry of live) {
        subagentRuns.set(entry.runId, entry);
      }
      const params = { runs: toRunMap([running, ended, live[1]!]), now };
      const index = buildSubagentRunReadIndexFromRuns(params);
      expect(index.atTime(now).countActiveDescendantRuns(root)).toBe(1);
      release();
      expect(index.getDisplaySubagentRun(running.childSessionKey)).toBe(running);
      expect(index.countActiveDescendantRuns(root)).toBe(0);
      expect(index.atTime(now).getDisplaySubagentRun(running.childSessionKey)).toBe(ended);
      expect(index.getDisplaySubagentRun(running.childSessionKey)).toBe(running);
    } finally {
      release();
      for (const entry of live) {
        subagentRuns.delete(entry.runId);
      }
    }
  });

  it("counts collectors against the spawning owner and excludes them from announce admission", () => {
    const owner = "agent:main:telegram:default:direct:456";
    const entry = makeRun("collector", {
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

  it("uses the admission snapshot time for descendants at the stale boundary", () => {
    const capturedAt = Date.now();
    const parent = makeRun("ended-parent", { endedAt: capturedAt - 1 });
    const child = makeRun("boundary-child", {
      requesterSessionKey: parent.childSessionKey,
      createdAt: capturedAt - STALE_UNENDED_SUBAGENT_RUN_MS,
      startedAt: capturedAt - STALE_UNENDED_SUBAGENT_RUN_MS,
    });
    const runs = toRunMap([parent, child]);
    const index = buildSubagentRunReadIndexFromRuns({ runs, now: capturedAt });
    expect(index.countActiveDescendantRuns(parent.childSessionKey)).toBe(1);
    expect(index.nextChangeAt(parent.childSessionKey)).toBe(capturedAt);
    const expired = index.atTime(capturedAt + 1);
    expect(expired.countActiveDescendantRuns(parent.childSessionKey)).toBe(0);
    expect(expired.nextChangeAt(parent.childSessionKey)).toBe(Infinity);
    expect(expired.atTime(capturedAt).countActiveDescendantRuns(parent.childSessionKey)).toBe(1);
    using _ = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(capturedAt)
      .mockReturnValue(capturedAt + 1);
    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(1);
  });

  it("preserves breadth-first cycle traversal and refreshes a cached tree after a generation moves", () => {
    const rows = ["child", "sibling", "parent"].map((id) =>
      makeRun(id, {
        childSessionKey: id,
        requesterSessionKey: id === "parent" ? "child" : "parent",
        ...(id === "child" ? { generation: 1 } : {}),
      }),
    );
    let index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap(rows) });
    for (const view of [index, index.atTime(100)]) {
      expect(descendants(view, "parent")).toEqual(["child", "sibling", "parent"]);
      expect(view.countPendingDescendantRuns("parent")).toBe(3);
    }
    const successor = makeRun("successor", {
      ...rows[0]!,
      requesterSessionKey: "new-parent",
      generation: 2,
    });
    index = index.patch(toRunMap([successor]), new Map());
    expect(descendants(index, "parent")).toEqual(["sibling"]);
    expect(descendants(index, "new-parent")).toEqual(["successor", "parent", "sibling"]);
    expect(index.countPendingDescendantRuns("parent")).toBe(1);
    expect(index.countPendingDescendantRuns("new-parent")).toBe(3);
  });

  it.each([
    { requesterSessionKey: "agent:main:main", requesterAgentId: undefined, matches: true },
    { requesterSessionKey: "agent:main:main", requesterAgentId: "other", matches: false },
    { requesterSessionKey: "global", requesterAgentId: undefined, matches: false },
    { requesterSessionKey: "global", requesterAgentId: "main", matches: true },
    { requesterSessionKey: "global", requesterAgentId: "other", matches: false },
  ])(
    "resolves requester ownership without backfill ($requesterSessionKey, $requesterAgentId)",
    ({ requesterSessionKey, requesterAgentId, matches }) => {
      const entry = makeRun("legacy-requester", { requesterSessionKey, requesterAgentId });
      const before = structuredClone(entry);

      expect(
        listRunsForRequesterFromRuns(toRunMap([entry]), requesterSessionKey, {
          requesterAgentId: "main",
        }),
      ).toEqual(matches ? [entry] : []);
      expect(entry).toEqual(before);
    },
  );

  it("scopes direct children to the requester run window", () => {
    const parent = makeRun("parent", { createdAt: 200, startedAt: 200, endedAt: 260 });
    const old = makeRun("old", {
      childSessionKey: parent.childSessionKey,
      createdAt: 100,
      startedAt: 100,
      endedAt: 150,
    });
    const runs = toRunMap([
      old,
      parent,
      ...[130, 210, 220, 270].map((createdAt) =>
        makeRun(`child-${createdAt}`, {
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

  it("gates late announces after run-mode parent cleanup", () => {
    const spawnMode = "run";
    const parent = makeRun("parent", { createdAt: 2, endedAt: 100, spawnMode });
    const old = makeRun("old", {
      childSessionKey: parent.childSessionKey,
      createdAt: 1,
      endedAt: 10,
      cleanupCompletedAt: 11,
      spawnMode,
    });
    const children = ["one", "two"].map((runId, index) =>
      makeRun(runId, {
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
    const last = makeRun("last", {
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
    expect(ignored()).toBe(true);
  });
});

describe("hasDescendantRunAwaitingSettleFromRuns", () => {
  const requester = "agent:main:main";

  it("scopes descendants ended during the batch without pruning an old parent", () => {
    const batchCreatedAt = Date.now() - 1_000;
    const parent = makeRun("old-parent", {
      requesterSessionKey: requester,
      createdAt: batchCreatedAt - 3_000,
      endedAt: batchCreatedAt - 2_000,
    });
    const descendant = makeRun("descendant", {
      requesterSessionKey: parent.childSessionKey,
      createdAt: batchCreatedAt - 2_500,
      startedAt: batchCreatedAt - 2_500,
      endedAt: batchCreatedAt + 1,
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
    });
    const index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap([parent, descendant]) });
    expect(index.hasDescendantRunAwaitingSettle(requester, undefined, batchCreatedAt)).toBe(true);
    expect(index.countPendingDescendantRuns(requester)).toBe(2);
    expect(index.hasDescendantRunAwaitingSettle(requester, descendant.runId, batchCreatedAt)).toBe(
      false,
    );
  });
});
