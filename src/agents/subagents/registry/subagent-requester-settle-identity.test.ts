import { expect, it } from "vitest";
import {
  makeSettledChild,
  REQUESTER,
} from "../announce/subagent-announce.requester-settle-wake.test-support.js";
import { isRequesterSettleWakeForRun } from "./subagent-requester-settle-identity.js";

const identity = {
  requesterSessionKey: REQUESTER,
  requesterAgentId: "main",
  batchRunIds: ["run-b"],
  rearmGeneration: 1,
};
const { batchRunIds, rearmGeneration: generation } = identity;
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
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      batchRunIds,
      rearmGeneration: generation,
      ...wakeOverrides,
    },
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
  ["deliverable", undefined, false, false, true],
  ["private", "parent", false, false, false],
  ["yielded private", "parent", false, true, true],
  ["paused private", "parent", true, false, true],
] as const)(
  "recognizes the persisted admitted retry for %s custody",
  (_name, completionTarget, pause, yielded, matched) => {
    const entry = child(
      { completionTarget, pauseReason: pause ? "sessions_yield" : undefined },
      {
        status: "dispatching",
        attemptCount: 2,
        pauseNotice: pause ? { acknowledgment: "Waiting for direction" } : undefined,
        yieldedFinalDeliverable: yielded || undefined,
      },
    );
    const persistedRunId = pause
      ? "announce:requester-settle:main:agent:main:main:run-b:yield-1:pause:retry-1"
      : retryId;
    const matches = (runId: string) => recognizes(entry, runId);
    const originalRunId = persistedRunId.replace(":retry-1", "");
    const nextRunId = persistedRunId.replace(":retry-1", ":retry-2");
    const observed = () => [persistedRunId, nextRunId, originalRunId].map(matches);
    entry.requesterSettleWake!.attemptCount = 0;
    expect(matches(originalRunId)).toBe(true);
    entry.requesterSettleWake!.attemptCount = 2;
    expect(observed()).toEqual([matched, false, !matched]);
    entry.requesterSettleWake!.status = "pending";
    expect(matches(persistedRunId)).toBe(matched);
    entry.requesterSettleWake!.nextAttemptAt = 30_000;
    expect([matches(persistedRunId), matches(nextRunId)]).toEqual([matched, false]);
    entry.requesterSettleWake!.status = "dispatching";
    entry.requesterSettleWake!.nextAttemptAt = undefined;
    entry.requesterSettleWake!.attemptCount = 3;
    expect(observed()).toEqual([false, matched, !matched]);
    entry.requesterSettleWake!.rearmGeneration = 2;
    expect(matches(nextRunId)).toBe(false);
  },
);

it.each([
  ["requester", { requesterSessionKey: "other" }, 1],
  ["agent", { requesterAgentId: "other" }, 1],
  ["store", { requesterStorePath: "/synthetic/other.sqlite" }, 1],
  ["generation", {}, 2],
] as const)(
  "excludes a frozen member rebound to another %s",
  (_difference, binding, rearmGeneration) => {
    const entry = child(
      { requesterStorePath: "/synthetic/requester.sqlite" },
      { batchRunIds: ["run-b", "run-other"] },
    );
    const other = makeSettledChild({
      ...entry,
      runId: "run-other",
      ...binding,
      requesterSettleWake: { ...entry.requesterSettleWake!, rearmGeneration },
    });
    expect(recognizes(entry, retryId.replace(":retry-1", ""), [entry, other])).toBe(true);
  },
);
