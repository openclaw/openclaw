import { describe, expect, it } from "vitest";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import {
  getSubagentRunByChildSessionKeyFromRuns,
  buildSubagentRunReadIndexFromRuns,
  countActiveRunsForSessionFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildSubagentRunView } from "./subagent-run-view.js";

function makeRun(overrides: SubagentRunRecordOverrides): SubagentRunRecord {
  return createSubagentRunRecord({
    childSessionKey: `agent:main:subagent:${overrides.runId}`,
    requesterSessionKey: "agent:main:main",
    cleanup: "keep",
    ...overrides,
  });
}

function toRunMap(runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run]));
}

describe("raw child owner lookup compatibility", () => {
  it("hides older owner rows behind the latest legacy row", () => {
    const now = Date.now();
    const owners = ["main", undefined, "research"];
    const view = buildSubagentRunView({
      runs: owners.map((childAgentId, index) =>
        makeRun({
          runId: childAgentId ?? "legacy",
          childSessionKey: "global",
          childAgentId,
          createdAt: now - index,
        }),
      ),
      recentMinutes: 30,
      countPendingDescendantRuns: () => 0,
      now,
    });
    expect(view.latest.map((entry) => entry.runId)).toEqual(["main"]);
  });

  // Registry-level compatibility: tools always supply owners for new raw registrations.
  it.each([
    ["research", "research"],
    ["invalid/owner", "legacy"],
  ])("retains legacy raw rows while selecting owner %s", (owner, expected) => {
    const runs = toRunMap(
      [undefined, "main", "research"].map((childAgentId, index) =>
        makeRun({
          runId: childAgentId ?? "legacy",
          childSessionKey: "global",
          childAgentId,
          generation: index + 1,
        }),
      ),
    );
    expect(getSubagentRunByChildSessionKeyFromRuns(runs, "global", owner)?.runId).toBe(expected);
  });
});

describe("suspended descendant accounting", () => {
  it("releases finished ancestors with suspended descendants without settling cleanup", () => {
    const now = Date.now();
    const parent = makeRun({ runId: "parent", endedAt: now - 2_000 });
    const child = makeRun({
      runId: "suspended-child",
      requesterSessionKey: parent.childSessionKey,
      endedAt: now - 1_000,
      delivery: { status: "suspended", suspendedAt: now, suspendedReason: "permanent_failure" },
    });
    const runs = toRunMap([parent, child]);

    expect(countActiveRunsForSessionFromRuns(runs, parent.requesterSessionKey)).toBe(0);
    for (const projected of [false, true]) {
      const index = buildSubagentRunReadIndexFromRuns({
        runs: projected
          ? new Map([...runs].map(([id, run]) => [id, projectSubagentRunForSessionList(run)]))
          : runs,
      });
      expect(index.countPendingDescendantRuns(parent.childSessionKey)).toBe(1);
      expect(
        index.countPendingDescendantRuns(parent.childSessionKey, {
          excludeSuspendedDelivery: true,
        }),
      ).toBe(0);
      expect(index.countPendingDescendantRuns(parent.childSessionKey)).toBe(1);
    }
    expect(runs.get(child.runId)).toBe(child);
    expect(child.cleanupCompletedAt).toBeUndefined();
    expect(child.delivery?.status).toBe("suspended");
  });

  it.each(["running", "pending"] as const)(
    "keeps ancestors active for %s grandchildren below a suspended descendant",
    (status) => {
      const now = Date.now();
      const parent = makeRun({ runId: "parent", endedAt: now - 3_000 });
      const child = makeRun({
        runId: "suspended-child",
        requesterSessionKey: parent.childSessionKey,
        endedAt: now - 2_000,
        delivery: { status: "suspended", suspendedAt: now },
      });
      const grandchild = makeRun({
        runId: "grandchild",
        requesterSessionKey: child.childSessionKey,
        createdAt: now - 1_000,
        startedAt: now - 1_000,
        ...(status === "running"
          ? { delivery: { status: "suspended", suspendedAt: now } }
          : { endedAt: now, delivery: { status } }),
      });
      const runs = toRunMap([parent, child, grandchild]);
      const index = buildSubagentRunReadIndexFromRuns({ runs });

      expect(countActiveRunsForSessionFromRuns(runs, parent.requesterSessionKey)).toBe(1);
      expect(
        index.countPendingDescendantRuns(parent.childSessionKey, {
          excludeSuspendedDelivery: true,
        }),
      ).toBe(1);
      expect(index.countPendingDescendantRuns(parent.childSessionKey)).toBe(2);
    },
  );
});
