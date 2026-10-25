import { describe, expect, it } from "vitest";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  buildSubagentRunReadIndexFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const root = "agent:main:main";
const child = (id: string) => `agent:main:subagent:${id}`;
function makeRun(runId: string, overrides: Partial<SubagentRunRecordOverrides> = {}) {
  return createSubagentRunRecord({
    runId,
    childSessionKey: child(runId),
    requesterDisplayKey: overrides.requesterSessionKey ?? root,
    ...overrides,
  });
}

const toRunMap = (runs: SubagentRunRecord[]) => new Map(runs.map((run) => [run.runId, run]));

describe("subagent registry read index", () => {
  it("indexes the latest generation for each child session", () => {
    const childSessionKey = child("restarted");
    const olderGeneration = makeRun("run-newer-created-at", {
      childSessionKey,
      generation: 1,
      createdAt: 200,
    });
    const latestGeneration = makeRun("run-latest-generation", {
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
    const parent = child("parent");
    const liveChild = "agent:main:subagent:parent:subagent:live-child";
    const movedChild = child("moved-child");
    const ownedRun = (
      runId: string,
      childSessionKey: string,
      controllerSessionKey: string,
      createdAt: number,
      startedAt: number,
      endedAt?: number,
    ) =>
      makeRun(runId, {
        childSessionKey,
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        createdAt: now + createdAt,
        startedAt: now + startedAt,
        endedAt: endedAt === undefined ? undefined : now + endedAt,
      });
    const runs = toRunMap([
      ownedRun("run-parent", parent, root, -5_000, -4_500, -2_500),
      ownedRun("run-live-child", liveChild, parent, -2_000, -1_500),
      ownedRun("run-moved-old", movedChild, root, -4_000, -3_500),
      ownedRun("run-moved-new", movedChild, "agent:main:other-controller", -1_000, -900),
    ]);

    const index = buildSubagentRunReadIndexFromRuns({ runs, now });

    expect(index.runsByControllerSessionKey.get(root)).toEqual([
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

    expect(index.runsByControllerSessionKey.has(root)).toBe(false);
    expect(index.getDisplaySubagentRun("agent:main:subagent:missing")).toBeNull();
    expect(index.countActiveDescendantRuns("agent:main:main")).toBe(0);
  });

  it("advances the clock over retained groups after the source map is cleared", () => {
    const startedAt = Date.UTC(2026, 0, 1);
    const childSessionKey = child("reused");
    const timedRun = (id: string, overrides: Partial<SubagentRunRecordOverrides> = {}) =>
      makeRun(id, { createdAt: startedAt, startedAt, ...overrides });
    const active = timedRun("older-active", {
      childSessionKey,
      generation: 1,
    });
    const ended = timedRun("newer-ended", {
      childSessionKey,
      generation: 2,
      createdAt: startedAt + 100,
      startedAt: startedAt + 100,
      endedAt: startedAt + 500,
      cleanupCompletedAt: startedAt + 500,
    });
    const descendant = timedRun("active-descendant");
    const runs = toRunMap([active, ended, descendant]);
    const grouped = buildSubagentRunReadIndexFromRuns({ runs, now: startedAt + 1_000 });
    runs.clear();

    const before = grouped.atTime(startedAt + 1_000);
    expect(before.getDisplaySubagentRun(childSessionKey)).toBe(active);
    expect(before.listDescendantRunsForRequester(root)).toEqual([ended, descendant]);
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

  it("selects the latest in-memory generation: ended over active", () => {
    const childSessionKey = child("display-generation");
    const makeGeneration = (runId: string, generation: number, endedAt?: number) =>
      makeRun(runId, { childSessionKey, generation, endedAt });
    const persisted = makeGeneration("run-persisted", 3);
    const older = makeGeneration("run-memory-older", 1);
    const newer = makeGeneration("run-memory-newer", 2, 250);
    const index = buildSubagentRunReadIndexFromRuns({
      runs: toRunMap([persisted]),
      inMemoryRuns: [newer, older],
    });

    expect(index.getDisplaySubagentRun(childSessionKey)).toBe(newer);
  });
});
