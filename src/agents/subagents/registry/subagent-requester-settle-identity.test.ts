import { describe, expect, it } from "vitest";
import {
  makeSettledChild,
  REQUESTER,
} from "../announce/subagent-announce.requester-settle-wake.test-support.js";
import {
  buildRequesterSettleWakeIdentity,
  isRequesterSettleWakeForRun,
} from "./subagent-requester-settle-identity.js";

describe("requester settle wake identity", () => {
  it.each([
    { status: "pending" as const, attemptCount: 1, nextAttemptAt: 30_000 },
    { status: "dispatching" as const, attemptCount: 2, nextAttemptAt: undefined },
  ])("keeps the known-result continuation identity while $status", (retainedWake) => {
    expect(
      buildRequesterSettleWakeIdentity({
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        batchRunIds: ["run-b"],
        rearmGeneration: 1,
        retainedWake,
      }).runId,
    ).toBe("announce:requester-settle:main:agent:main:main:run-b:yield-1:retry-1");
  });

  // The control scope must recognize exactly the key dispatch used, or a settle
  // turn loses authority over its own children.
  it.each([
    { name: "private batch", yieldedFinalDeliverable: undefined, pause: false },
    { name: "deliverable yielded batch", yieldedFinalDeliverable: true as const, pause: false },
    { name: "paused private batch", yieldedFinalDeliverable: undefined, pause: true },
  ])("matches the dispatched key: $name", ({ yieldedFinalDeliverable, pause }) => {
    const entry = makeSettledChild({
      runId: "run-b",
      requesterAgentId: "main",
      completionTarget: "parent",
      ...(pause ? { pauseReason: "sessions_yield" as const } : {}),
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-b"],
        rearmGeneration: 1,
        ...(pause ? { pauseNotice: { acknowledgment: "Waiting for direction" } } : {}),
        ...(yieldedFinalDeliverable ? { yieldedFinalDeliverable } : {}),
      },
    });
    const dispatched = buildRequesterSettleWakeIdentity({
      requesterSessionKey: REQUESTER,
      requesterAgentId: "main",
      batchRunIds: ["run-b"],
      rearmGeneration: 1,
      pause,
    }).runId;
    expect(
      isRequesterSettleWakeForRun({
        entry,
        runId: dispatched,
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        runsById: new Map([["run-b", entry]]),
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "deliverable",
      completionTarget: undefined,
      pause: false,
      yielded: false,
      matched: true,
    },
    {
      name: "private",
      completionTarget: "parent" as const,
      pause: false,
      yielded: false,
      matched: false,
    },
    {
      name: "yielded private",
      completionTarget: "parent" as const,
      pause: false,
      yielded: true,
      matched: true,
    },
    {
      name: "paused private",
      completionTarget: "parent" as const,
      pause: true,
      yielded: false,
      matched: true,
    },
  ])(
    "recognizes the persisted admitted retry for $name custody",
    ({ completionTarget, pause, yielded, matched }) => {
      const entry = makeSettledChild({
        runId: "run-b",
        requesterAgentId: "main",
        completionTarget,
        ...(pause ? { pauseReason: "sessions_yield" as const } : {}),
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 2,
          batchRunIds: ["run-b"],
          rearmGeneration: 1,
          ...(pause ? { pauseNotice: { acknowledgment: "Waiting for direction" } } : {}),
          ...(yielded ? { yieldedFinalDeliverable: true } : {}),
        },
      });
      const persistedRunId = pause
        ? "announce:requester-settle:main:agent:main:main:run-b:yield-1:pause:retry-1"
        : "announce:requester-settle:main:agent:main:main:run-b:yield-1:retry-1";
      const recognizes = (runId: string) =>
        isRequesterSettleWakeForRun({
          entry,
          runId,
          requesterSessionKey: REQUESTER,
          requesterAgentId: "main",
          runsById: new Map([[entry.runId, entry]]),
        });
      const originalRunId = persistedRunId.replace(":retry-1", "");
      const nextRunId = persistedRunId.replace(":retry-1", ":retry-2");
      expect(recognizes(persistedRunId)).toBe(matched);
      expect(recognizes(nextRunId)).toBe(false);
      expect(recognizes(originalRunId)).toBe(!matched);
      entry.requesterSettleWake!.status = "pending";
      expect(recognizes(persistedRunId)).toBe(matched);
      entry.requesterSettleWake!.nextAttemptAt = 30_000;
      expect(recognizes(persistedRunId)).toBe(matched);
      expect(recognizes(nextRunId)).toBe(false);
      entry.requesterSettleWake!.status = "dispatching";
      entry.requesterSettleWake!.nextAttemptAt = undefined;
      entry.requesterSettleWake!.attemptCount = 3;
      expect(recognizes(nextRunId)).toBe(matched);
      expect(recognizes(persistedRunId)).toBe(false);
      expect(recognizes(originalRunId)).toBe(!matched);
      entry.requesterSettleWake!.rearmGeneration = 2;
      expect(recognizes(nextRunId)).toBe(false);
    },
  );

  it("recognizes an admitted frozen wake after an earlier member retires", () => {
    const entry = makeSettledChild({
      runId: "run-b",
      requesterAgentId: "main",
      requesterSettleWake: {
        status: "dispatching",
        batchRunIds: ["retired-run", "run-b"],
        rearmGeneration: 1,
        attemptCount: 1,
      },
    });
    expect(
      isRequesterSettleWakeForRun({
        entry,
        runId: "announce:requester-settle:main:agent:main:main:run-b:yield-1",
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        runsById: new Map([[entry.runId, entry]]),
      }),
    ).toBe(true);
  });

  it.each(["requester", "agent", "store", "generation"] as const)(
    "excludes a frozen member rebound to another %s",
    (difference) => {
      const entry = makeSettledChild({
        runId: "run-b",
        requesterAgentId: "main",
        requesterStorePath: "/synthetic/requester.sqlite",
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["run-b", "run-other"],
          rearmGeneration: 1,
        },
      });
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
      expect(
        isRequesterSettleWakeForRun({
          entry,
          runId: "announce:requester-settle:main:agent:main:main:run-b:yield-1",
          requesterSessionKey: REQUESTER,
          requesterAgentId: "main",
          runsById: new Map([
            [entry.runId, entry],
            [other.runId, other],
          ]),
        }),
      ).toBe(true);
    },
  );
});
