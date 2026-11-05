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
      endedAt: 250,
    });

    const index = buildLatestSubagentRunReadIndexFromRuns(
      toRunMap([olderGeneration, latestGeneration]),
    );

    expect(index.getLatestSubagentRun(childSessionKey)).toBe(latestGeneration);
    expect(index.getLatestSubagentRun("agent:main:subagent:missing")).toBeNull();
    const persisted = makeRun("persisted", { childSessionKey, generation: 3 });
    const live = buildSubagentRunReadIndexFromRuns({
      runs: toRunMap([persisted]),
      inMemoryRuns: [latestGeneration, olderGeneration],
    });
    expect(live.getDisplaySubagentRun(childSessionKey)).toBe(latestGeneration);
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
});
