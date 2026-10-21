import { expect, it } from "vitest";
import {
  makeSettledChild,
  REQUESTER,
} from "../announce/subagent-announce.requester-settle-wake.test-support.js";
import {
  buildRequesterSettleWakeIdentity,
  isRequesterSettleWakeForRun,
} from "./subagent-requester-settle-identity.js";

const identity = {
  requesterSessionKey: REQUESTER,
  requesterAgentId: "main",
  batchRunIds: ["run-b"],
  rearmGeneration: 1,
};
const wake = {
  status: "pending" as const,
  attemptCount: 0,
  batchRunIds: identity.batchRunIds,
  rearmGeneration: 1,
};
const retryId = "announce:requester-settle:main:agent:main:main:run-b:yield-1:retry-1";
type Child = ReturnType<typeof makeSettledChild>;
function child(
  overrides: Partial<Child> = {},
  wakeOverrides: Partial<NonNullable<Child["requesterSettleWake"]>> = {},
) {
  return makeSettledChild({
    runId: "run-b",
    requesterAgentId: "main",
    ...overrides,
    requesterSettleWake: { ...wake, ...wakeOverrides },
  });
}
function recognizes(entry: Child, runId: string, members = [entry]) {
  return isRequesterSettleWakeForRun({
    ...identity,
    entry,
    runId,
    runsById: new Map(members.map((member) => [member.runId, member])),
  });
}

it.each([
  { status: "pending" as const, attemptCount: 1, nextAttemptAt: 30_000 },
  { status: "dispatching" as const, attemptCount: 2, nextAttemptAt: undefined },
])("keeps the known-result continuation identity while $status", (retainedWake) => {
  expect(buildRequesterSettleWakeIdentity({ ...identity, retainedWake }).runId).toBe(retryId);
});

// The control scope must recognize exactly the key dispatch used, or a settle
// turn loses authority over its own children.
it.each([
  { name: "private batch", yieldedFinalDeliverable: undefined, pause: false },
  { name: "deliverable yielded batch", yieldedFinalDeliverable: true as const, pause: false },
  { name: "paused private batch", yieldedFinalDeliverable: undefined, pause: true },
])("matches the dispatched key: $name", ({ yieldedFinalDeliverable, pause }) => {
  const entry = child(
    { completionTarget: "parent", ...(pause ? { pauseReason: "sessions_yield" as const } : {}) },
    {
      ...(pause ? { pauseNotice: { acknowledgment: "Waiting for direction" } } : {}),
      ...(yieldedFinalDeliverable ? { yieldedFinalDeliverable } : {}),
    },
  );
  const dispatched = buildRequesterSettleWakeIdentity({
    ...identity,
    pause,
  }).runId;
  expect(recognizes(entry, dispatched)).toBe(true);
});

it.each([
  ["deliverable", undefined, false, false, true],
  ["private", "parent", false, false, false],
  ["yielded private", "parent", false, true, true],
  ["paused private", "parent", true, false, true],
] as const)(
  "recognizes the persisted admitted retry for %s custody",
  (_name, completionTarget, pause, yielded, matched) => {
    const entry = child(
      { completionTarget, ...(pause ? { pauseReason: "sessions_yield" as const } : {}) },
      {
        status: "dispatching",
        attemptCount: 2,
        ...(pause ? { pauseNotice: { acknowledgment: "Waiting for direction" } } : {}),
        ...(yielded ? { yieldedFinalDeliverable: true } : {}),
      },
    );
    const persistedRunId = pause
      ? "announce:requester-settle:main:agent:main:main:run-b:yield-1:pause:retry-1"
      : retryId;
    const matches = (runId: string) => recognizes(entry, runId);
    const originalRunId = persistedRunId.replace(":retry-1", "");
    const nextRunId = persistedRunId.replace(":retry-1", ":retry-2");
    expect(matches(persistedRunId)).toBe(matched);
    expect(matches(nextRunId)).toBe(false);
    expect(matches(originalRunId)).toBe(!matched);
    entry.requesterSettleWake!.status = "pending";
    expect(matches(persistedRunId)).toBe(matched);
    entry.requesterSettleWake!.nextAttemptAt = 30_000;
    expect(matches(persistedRunId)).toBe(matched);
    expect(matches(nextRunId)).toBe(false);
    entry.requesterSettleWake!.status = "dispatching";
    entry.requesterSettleWake!.nextAttemptAt = undefined;
    entry.requesterSettleWake!.attemptCount = 3;
    expect(matches(nextRunId)).toBe(matched);
    expect(matches(persistedRunId)).toBe(false);
    expect(matches(originalRunId)).toBe(!matched);
    entry.requesterSettleWake!.rearmGeneration = 2;
    expect(matches(nextRunId)).toBe(false);
  },
);

it("recognizes an admitted frozen wake after an earlier member retires", () => {
  const entry = child(
    {},
    {
      status: "dispatching",
      batchRunIds: ["retired-run", "run-b"],
      attemptCount: 1,
    },
  );
  expect(recognizes(entry, retryId.replace(":retry-1", ""))).toBe(true);
});

it.each(["requester", "agent", "store", "generation"] as const)(
  "excludes a frozen member rebound to another %s",
  (difference) => {
    const entry = child(
      { requesterStorePath: "/synthetic/requester.sqlite" },
      { batchRunIds: ["run-b", "run-other"] },
    );
    const other = makeSettledChild({
      ...entry,
      runId: "run-other",
      ...(difference === "requester" ? { requesterSessionKey: "other" } : {}),
      ...(difference === "agent" ? { requesterAgentId: "other" } : {}),
      ...(difference === "store" ? { requesterStorePath: "/synthetic/other.sqlite" } : {}),
      requesterSettleWake: {
        ...entry.requesterSettleWake,
        status: "pending",
        attemptCount: 0,
        rearmGeneration: difference === "generation" ? 2 : 1,
      },
    });
    expect(recognizes(entry, retryId.replace(":retry-1", ""), [entry, other])).toBe(true);
  },
);
