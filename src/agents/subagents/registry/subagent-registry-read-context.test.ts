import { describe, expect, it } from "vitest";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  buildSubagentRunReadIndexFromRuns,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeRun(
  runId: string,
  overrides: Partial<SubagentRunRecordOverrides> = {},
): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    controllerSessionKey: overrides.requesterSessionKey,
    ...overrides,
  });
}

function toRunMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord> {
  return new Map(runs.map((run) => [run.runId, run]));
}

function descendantCounts(index: SubagentRunReadIndex, root: string) {
  return [index.countActiveDescendantRuns(root), index.countPendingDescendantRuns(root)];
}

describe("subagent registry read index", () => {
  it("indexes the latest generation for each child session", () => {
    const child = "agent:main:subagent:restarted";
    const older = makeRun("older", { childSessionKey: child, generation: 1, createdAt: 200 });
    const latest = makeRun("latest", {
      childSessionKey: ` ${child} `,
      generation: 2,
      createdAt: 100,
    });

    const index = buildLatestSubagentRunReadIndexFromRuns(toRunMap([older, latest]));

    expect(index.getLatestSubagentRun(child)).toBe(latest);
    expect(index.getLatestSubagentRun("agent:main:subagent:missing")).toBeNull();
  });

  it("indexes controller ownership and pending descendants from the latest runs", () => {
    const now = Date.now();
    const root = "agent:main:main";
    const parent = "agent:main:subagent:parent";
    const liveChild = "agent:main:subagent:parent:subagent:live-child";
    const movedChild = "agent:main:subagent:moved-child";
    const runs = toRunMap([
      makeRun("run-parent", {
        childSessionKey: parent,
        requesterSessionKey: root,
        createdAt: now - 5_000,
        startedAt: now - 4_500,
        endedAt: now - 2_500,
      }),
      makeRun("run-live-child", {
        childSessionKey: liveChild,
        requesterSessionKey: parent,
        createdAt: now - 2_000,
        startedAt: now - 1_500,
      }),
      makeRun("run-moved-old", {
        childSessionKey: movedChild,
        requesterSessionKey: root,
        createdAt: now - 4_000,
        startedAt: now - 3_500,
      }),
      makeRun("run-moved-new", {
        childSessionKey: movedChild,
        requesterSessionKey: "agent:main:other-controller",
        createdAt: now - 1_000,
        startedAt: now - 900,
      }),
    ]);

    const index = buildSubagentRunReadIndexFromRuns({ runs, now });

    expect(index.runsByControllerSessionKey.get(root)).toEqual([
      runs.get("run-parent"),
      runs.get("run-moved-old"),
    ]);
    expect(index.getDisplaySubagentRun(parent)).toBe(runs.get("run-parent"));
    expect(descendantCounts(index, root)).toEqual([1, 2]);
    expect(index.hasDescendantRunAwaitingSettle(root)).toBe(true);
    expect(index.listDescendantRunsForRequester(root)).toEqual([
      runs.get("run-parent"),
      runs.get("run-live-child"),
    ]);
  });

  it("handles empty registry snapshots", () => {
    const index = buildSubagentRunReadIndexFromRuns({ runs: toRunMap([]) });

    expect(index.runsByControllerSessionKey.get("agent:main:main") ?? []).toStrictEqual([]);
    expect(index.getDisplaySubagentRun("agent:main:subagent:missing")).toBeNull();
    expect(index.countActiveDescendantRuns("agent:main:main")).toBe(0);
  });

  it("advances the clock over retained groups after the source map is cleared", () => {
    const startedAt = Date.UTC(2026, 0, 1);
    const root = "agent:main:main";
    const childSessionKey = "agent:main:subagent:reused";
    const active = makeRun("older-active", {
      childSessionKey,
      generation: 1,
      createdAt: startedAt,
      startedAt,
    });
    const ended = makeRun("newer-ended", {
      childSessionKey,
      generation: 2,
      createdAt: startedAt + 100,
      startedAt: startedAt + 100,
      endedAt: startedAt + 500,
      cleanupCompletedAt: startedAt + 500,
    });
    const descendant = makeRun("descendant", { createdAt: startedAt, startedAt });
    const runs = toRunMap([active, ended, descendant]);
    const grouped = buildSubagentRunReadIndexFromRuns({ runs, now: startedAt + 1_000 });
    runs.clear();

    const before = grouped.atTime(startedAt + 1_000);
    expect(before.getDisplaySubagentRun(childSessionKey)).toBe(active);
    expect(descendantCounts(before, root)).toEqual([1, 1]);
    const after = grouped.atTime(startedAt + 2 * 60 * 60_000 + 1);
    expect(after.getDisplaySubagentRun(childSessionKey)).toBe(ended);
    expect(descendantCounts(after, root)).toEqual([0, 0]);
    expect(after.hasDescendantRunAwaitingSettle(root)).toBe(false);
    expect(grouped.getDisplaySubagentRun(childSessionKey)).toBe(active);
    expect(before.countActiveDescendantRuns(root)).toBe(1);
    expect(after.inputs).toBe(before.inputs);
    expect(after.inputs).toBe(grouped.inputs);
  });

  it("selects the latest in-memory generation: ended over active", () => {
    const child = "agent:main:subagent:display-generation";
    const persisted = makeRun("persisted", { childSessionKey: child, generation: 3 });
    const older = makeRun("older", { childSessionKey: child, generation: 1 });
    const newer = makeRun("newer", { childSessionKey: child, generation: 2, endedAt: 250 });
    const index = buildSubagentRunReadIndexFromRuns({
      runs: toRunMap([persisted]),
      inMemoryRuns: [newer, older],
    });

    expect(index.getDisplaySubagentRun(child)).toBe(newer);
  });
});
