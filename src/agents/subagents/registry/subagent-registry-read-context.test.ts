// Subagent registry read-context tests cover the indexed snapshot used by hot
// prompt/control paths instead of repeatedly scanning the run map.
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

function makeRun(overrides: Partial<SubagentRunRecordOverrides>): SubagentRunRecord {
  const runId = overrides.runId ?? "run-default";
  const childSessionKey = overrides.childSessionKey ?? `agent:main:subagent:${runId}`;
  const requesterSessionKey = overrides.requesterSessionKey ?? "agent:main:main";
  return createSubagentRunRecord({
    runId,
    childSessionKey,
    controllerSessionKey: overrides.controllerSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: "test task",
    cleanup: "keep",
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  });
}

function toRunMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord> {
  return new Map(runs.map((run) => [run.runId, run]));
}

function listRunsForController(
  index: SubagentRunReadIndex,
  controllerSessionKey: string,
): readonly SubagentRunRecord[] {
  return index.runsByControllerSessionKey.get(controllerSessionKey.trim()) ?? [];
}

describe("subagent registry read index", () => {
  it("indexes the latest generation for each child session", () => {
    const childSessionKey = "agent:main:subagent:restarted";
    const olderGeneration = makeRun({
      runId: "run-newer-created-at",
      childSessionKey,
      generation: 1,
      createdAt: 200,
    });
    const latestGeneration = makeRun({
      runId: "run-latest-generation",
      childSessionKey: ` ${childSessionKey} `,
      generation: 2,
      createdAt: 100,
    });

    const index = buildLatestSubagentRunReadIndexFromRuns(
      toRunMap([olderGeneration, latestGeneration]),
    );

    expect(index.getLatestSubagentRun(childSessionKey)).toBe(latestGeneration);
    expect(index.getLatestSubagentRun("agent:main:subagent:missing")).toBeNull();
  });

  it("indexes controller ownership and pending descendants from the latest runs", () => {
    const now = Date.now();
    const root = "agent:main:main";
    const parent = "agent:main:subagent:parent";
    const liveChild = "agent:main:subagent:parent:subagent:live-child";
    const movedChild = "agent:main:subagent:moved-child";
    const runs = toRunMap([
      makeRun({
        runId: "run-parent",
        childSessionKey: parent,
        controllerSessionKey: root,
        requesterSessionKey: root,
        createdAt: now - 5_000,
        startedAt: now - 4_500,
        endedAt: now - 2_500,
      }),
      makeRun({
        runId: "run-live-child",
        childSessionKey: liveChild,
        controllerSessionKey: parent,
        requesterSessionKey: parent,
        createdAt: now - 2_000,
        startedAt: now - 1_500,
      }),
      makeRun({
        runId: "run-moved-old",
        childSessionKey: movedChild,
        controllerSessionKey: root,
        requesterSessionKey: root,
        createdAt: now - 4_000,
        startedAt: now - 3_500,
      }),
      makeRun({
        runId: "run-moved-new",
        childSessionKey: movedChild,
        controllerSessionKey: "agent:main:other-controller",
        requesterSessionKey: "agent:main:other-controller",
        createdAt: now - 1_000,
        startedAt: now - 900,
      }),
    ]);

    const index = buildSubagentRunReadIndexFromRuns({ runs, now });

    expect(listRunsForController(index, root)).toEqual([
      runs.get("run-parent"),
      runs.get("run-moved-old"),
    ]);
    expect(index.getDisplaySubagentRun(parent)).toBe(runs.get("run-parent"));
    expect(index.countActiveDescendantRuns(root)).toBe(1);
    expect(index.countPendingDescendantRuns(root)).toBe(2);
    expect(index.hasDescendantRunAwaitingSettle(root)).toBe(true);
    expect(index.listDescendantRunsForRequester(root)).toEqual([
      runs.get("run-parent"),
      runs.get("run-live-child"),
    ]);
  });

  it("handles empty registry snapshots", () => {
    const runs = new Map<string, SubagentRunRecord>();
    const index = buildSubagentRunReadIndexFromRuns({ runs });

    expect(listRunsForController(index, "agent:main:main")).toStrictEqual([]);
    expect(index.getDisplaySubagentRun("agent:main:subagent:missing")).toBeNull();
    expect(index.countActiveDescendantRuns("agent:main:main")).toBe(0);
  });

  it("advances the clock over retained groups after the source map is cleared", () => {
    const startedAt = Date.UTC(2026, 0, 1);
    const root = "agent:main:main";
    const childSessionKey = "agent:main:subagent:reused";
    const active = makeRun({
      runId: "older-active",
      childSessionKey,
      generation: 1,
      createdAt: startedAt,
      startedAt,
    });
    const ended = makeRun({
      runId: "newer-ended",
      childSessionKey,
      generation: 2,
      createdAt: startedAt + 100,
      startedAt: startedAt + 100,
      endedAt: startedAt + 500,
      cleanupCompletedAt: startedAt + 500,
    });
    const descendant = makeRun({
      runId: "active-descendant",
      createdAt: startedAt,
      startedAt,
    });
    const runs = toRunMap([active, ended, descendant]);
    const grouped = buildSubagentRunReadIndexFromRuns({ runs, now: startedAt + 1_000 });
    runs.clear();

    const before = grouped.atTime(startedAt + 1_000);
    expect(before.getDisplaySubagentRun(childSessionKey)).toBe(active);
    expect(before.countActiveDescendantRuns(root)).toBe(1);
    expect(before.countPendingDescendantRuns(root)).toBe(1);
    const after = grouped.atTime(startedAt + 2 * 60 * 60_000 + 1);
    expect(after.getDisplaySubagentRun(childSessionKey)).toBe(ended);
    expect(after.countActiveDescendantRuns(root)).toBe(0);
    expect(after.countPendingDescendantRuns(root)).toBe(0);
    expect(after.hasDescendantRunAwaitingSettle(root)).toBe(false);
    expect(grouped.getDisplaySubagentRun(childSessionKey)).toBe(active);
    expect(before.countActiveDescendantRuns(root)).toBe(1);
    expect(after.inputs).toBe(before.inputs);
    expect(after.inputs).toBe(grouped.inputs);
  });

  it.each([{ label: "ended over active", olderEndedAt: undefined, newerEndedAt: 250 }])(
    "selects the latest in-memory generation: $label",
    ({ olderEndedAt, newerEndedAt }) => {
      const childSessionKey = "agent:main:subagent:display-generation";
      const persisted = makeRun({
        runId: "run-persisted",
        childSessionKey,
        generation: 3,
      });
      const older = makeRun({
        runId: "run-memory-older",
        childSessionKey,
        generation: 1,
        endedAt: olderEndedAt,
      });
      const newer = makeRun({
        runId: "run-memory-newer",
        childSessionKey,
        generation: 2,
        endedAt: newerEndedAt,
      });
      const index = buildSubagentRunReadIndexFromRuns({
        runs: toRunMap([persisted]),
        inMemoryRuns: [newer, older],
      });

      expect(index.getDisplaySubagentRun(childSessionKey)).toBe(newer);
    },
  );
});
