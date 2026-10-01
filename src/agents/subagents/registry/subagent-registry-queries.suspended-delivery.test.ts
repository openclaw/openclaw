import { describe, expect, it } from "vitest";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  buildSubagentRunReadIndexFromRuns,
  countActiveRunsForSessionFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeRun(overrides: SubagentRunRecordOverrides): SubagentRunRecord {
  return createSubagentRunRecord({
    childSessionKey: `agent:main:subagent:${overrides.runId}`,
    requesterSessionKey: "agent:main:main",
    cleanup: "keep",
    ...overrides,
  });
}

function toRunMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord> {
  return new Map(runs.map((run) => [run.runId, run]));
}

describe("suspended descendant accounting", () => {
  it.each(["expiry", "permanent_failure"] as const)(
    "releases finished ancestors with %s-suspended descendants without settling cleanup",
    (suspendedReason) => {
      const now = Date.now();
      const parent = makeRun({ runId: "parent", endedAt: now - 2_000 });
      const child = makeRun({
        runId: "suspended-child",
        requesterSessionKey: parent.childSessionKey,
        endedAt: now - 1_000,
        delivery: { status: "suspended", suspendedAt: now, suspendedReason },
      });
      const runs = toRunMap([parent, child]);

      expect(countActiveRunsForSessionFromRuns(runs, parent.requesterSessionKey)).toBe(0);
      const index = buildSubagentRunReadIndexFromRuns({ runs });
      expect(index.countPendingDescendantRuns(parent.childSessionKey)).toBe(1);
      expect(
        index.countPendingDescendantRuns(parent.childSessionKey, {
          excludeSuspendedDelivery: true,
        }),
      ).toBe(0);
      expect(index.countPendingDescendantRuns(parent.childSessionKey)).toBe(1);
      expect(runs.get(child.runId)).toBe(child);
      expect(child.cleanupCompletedAt).toBeUndefined();
      expect(child.delivery?.status).toBe("suspended");
    },
  );

  it.each(["running", "pending", "in_progress"] as const)(
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
