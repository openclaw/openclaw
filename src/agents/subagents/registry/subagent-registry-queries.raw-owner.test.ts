import { expect, it } from "vitest";
import { createSubagentRunRecord as makeRun } from "../../subagent-test-fixtures.test-helpers.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import {
  getSubagentRunByChildSessionKeyFromRuns as findChildRun,
  buildSubagentRunReadIndexFromRuns as indexRuns,
  countActiveRunsForSessionFromRuns as countActiveRuns,
  listRunsForControllerFromRuns as listControlledRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildSubagentRunView } from "./subagent-run-view.js";

function toRunMap<T extends { runId: string }>(...runs: T[]) {
  return new Map(runs.map((run) => [run.runId, run]));
}

const rawOwners = (owners: (string | undefined)[], now = Date.now()) =>
  owners.map((childAgentId, index) =>
    makeRun({
      runId: childAgentId ?? "legacy",
      childSessionKey: "global",
      childAgentId,
      createdAt: now - index,
      generation: index + 1,
    }),
  );

it("preserves distinct owners and unresolved diagnostic rows", () => {
  const now = Date.now();
  const view = buildSubagentRunView({
    runs: rawOwners(["main", undefined, "research"], now),
    recentMinutes: 30,
    countPendingDescendantRuns: () => 0,
    now,
  });
  expect(view.latest.map((entry) => entry.runId)).toEqual(["main", "legacy", "research"]);
});

it.each([
  [undefined, undefined],
  ["research", "research"],
  ["invalid/owner", undefined],
])("retains legacy raw rows while selecting owner %s", (owner, expected) => {
  const runs = toRunMap(...rawOwners([undefined, "main", "research"]));
  expect(findChildRun(runs, "global", owner)?.runId).toBe(expected);
});

it.each([
  ["agent:research:main", undefined, "research", true],
  ["agent:research:main", "main", "research", true],
  ["agent:research:main", "main", "main", false],
  ["global", "research", "research", true],
  ["global", "research", "main", false],
  ["global", undefined, "research", false],
] as const)(
  "scopes controller %s with requester owner %s to agent %s (matches=%s)",
  (controllerSessionKey, requesterAgentId, controllerAgentId, matches) => {
    const run = makeRun({ runId: "controlled", controllerSessionKey, requesterAgentId });
    expect(listControlledRuns(toRunMap(run), controllerSessionKey, controllerAgentId)).toEqual(
      matches ? [run] : [],
    );
  },
);

it.each([
  ["agent:invalid/owner:child", undefined, "main"],
  ["agent:main:", "main", "main"],
  ["agent:main:child", "research", "main"],
  ["global", "invalid/owner", "main"],
  ["agent:main:subagent:qualified", undefined, "research"],
])(
  "refuses invalid ownership: key %s, recorded %s, selected %s",
  (childSessionKey, childAgentId, owner) => {
    const run = makeRun({ runId: "invalid", childSessionKey, childAgentId });
    expect(findChildRun(toRunMap(run), run.childSessionKey, owner)).toBeNull();
  },
);
it.each(["none", "running", "pending"] as const)(
  "accounts for %s grandchildren below a suspended child",
  (status) => {
    const now = Date.now();
    const hasGrandchild = status !== "none";
    const parent = makeRun({
      runId: "parent",
      childSessionKey: "agent:main:subagent:parent",
      endedAt: now - (hasGrandchild ? 3_000 : 2_000),
    });
    const suspended: SubagentRunRecord["delivery"] = { status: "suspended", suspendedAt: now };
    const child = makeRun({
      runId: "suspended-child",
      requesterSessionKey: parent.childSessionKey,
      childSessionKey: "agent:main:subagent:suspended-child",
      endedAt: now - (hasGrandchild ? 2_000 : 1_000),
      delivery: hasGrandchild ? suspended : { ...suspended, suspendedReason: "permanent_failure" },
    });
    const entries = [parent, child];
    if (hasGrandchild) {
      entries.push(
        makeRun({
          runId: "grandchild",
          requesterSessionKey: child.childSessionKey,
          childSessionKey: "agent:main:subagent:grandchild",
          createdAt: now - 1_000,
          startedAt: now - 1_000,
          ...(status === "running"
            ? { delivery: suspended }
            : { endedAt: now, delivery: { status: "pending" } }),
        }),
      );
    }
    const runs = toRunMap(...entries);
    expect(countActiveRuns(runs, parent.requesterSessionKey)).toBe(hasGrandchild ? 1 : 0);
    for (const rows of [entries, entries.map(projectSubagentRunForSessionList)]) {
      const index = indexRuns({ runs: toRunMap(...rows) });
      const count = (excludeSuspendedDelivery = false) =>
        index.countPendingDescendantRuns(parent.childSessionKey, { excludeSuspendedDelivery });
      const pending = hasGrandchild ? 2 : 1;
      expect([count(), count(true), count()]).toEqual([pending, pending - 1, pending]);
    }
    expect(runs.get(child.runId)).toBe(child);
    expect(child.cleanupCompletedAt).toBeUndefined();
    expect(child.delivery?.status).toBe("suspended");
  },
);
