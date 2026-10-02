import { describe, expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { getSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildSubagentRunView } from "./subagent-run-view.js";

function makeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "qualified",
    childSessionKey: "agent:main:subagent:qualified",
    requesterSessionKey: "agent:main:main",
    ...overrides,
  });
}

function toRunMap(runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run]));
}

describe("raw child owner lookup compatibility", () => {
  it.each([false, true])(
    "preserves distinct owners while hidden legacy rows fence older runs (legacy=%s)",
    (legacy) => {
      const now = Date.now();
      const owners = legacy ? ["main", undefined, "research"] : ["main", "research"];
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
      expect(view.latest.map((entry) => entry.runId)).toEqual(
        legacy ? ["main"] : ["main", "research"],
      );
    },
  );

  // Registry-level compatibility: tools always supply owners for new raw registrations.
  it.each([
    [undefined, "research"],
    [" MAIN ", "main"],
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

  it("keeps agent-qualified lookup behavior when a caller supplies another owner", () => {
    const run = makeRun({ runId: "qualified" });
    expect(
      getSubagentRunByChildSessionKeyFromRuns(toRunMap([run]), run.childSessionKey, "research"),
    ).toBe(run);
  });
});
