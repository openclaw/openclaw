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
  // The control scope must recognize exactly the key dispatch used, or a retried
  // settle turn loses authority over its own children.
  it.each([
    { name: "private batch", yieldedFinalDeliverable: undefined, suffix: false, pause: false },
    {
      name: "deliverable yielded batch",
      yieldedFinalDeliverable: true as const,
      suffix: true,
      pause: false,
    },
    { name: "paused private batch", yieldedFinalDeliverable: undefined, suffix: true, pause: true },
  ])("matches the dispatched retry key: $name", ({ yieldedFinalDeliverable, suffix, pause }) => {
    const entry = makeSettledChild({
      runId: "run-b",
      requesterAgentId: "main",
      completionTarget: "parent",
      ...(pause ? { pauseReason: "sessions_yield" as const } : {}),
      requesterSettleWake: {
        status: "dispatching",
        batchRunIds: ["run-b"],
        rearmGeneration: 1,
        attemptCount: 2,
        ...(pause ? { pauseNotice: { acknowledgment: "Waiting for direction" } } : {}),
        ...(yieldedFinalDeliverable ? { yieldedFinalDeliverable } : {}),
      },
    });
    const dispatched = buildRequesterSettleWakeIdentity({
      requesterSessionKey: REQUESTER,
      requesterAgentId: "main",
      batchRunIds: ["run-b"],
      rearmGeneration: 1,
      attemptIndex: 1,
      sharedAttemptKey: yieldedFinalDeliverable !== true,
      pause,
    }).runId;
    expect(dispatched.endsWith(":retry-1")).toBe(suffix);
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

  it.each([false, true])(
    "recognizes an admitted frozen wake after retirement (overlapping cohort: %s)",
    (overlap) => {
      const entry = makeSettledChild({
        runId: "run-b",
        requesterAgentId: "main",
        requesterSettleWake: {
          status: "dispatching",
          batchRunIds: overlap ? ["retired-run", "run-a", "run-b"] : ["retired-run", "run-b"],
          rearmGeneration: 1,
          attemptCount: 1,
          requesterYieldBatch: overlap ? true : undefined,
        },
      });
      const foreign = makeSettledChild({
        runId: "run-a",
        requesterSettleWake: {
          status: "dispatching",
          batchRunIds: ["run-a"],
          rearmGeneration: 1,
          attemptCount: 1,
          requesterYieldBatch: true,
        },
      });
      const runsById = new Map([[entry.runId, entry]]);
      if (overlap) {
        runsById.set(foreign.runId, foreign);
      }
      expect(
        isRequesterSettleWakeForRun({
          entry,
          runId: "announce:requester-settle:main:agent:main:main:run-b:yield-1",
          requesterSessionKey: REQUESTER,
          requesterAgentId: "main",
          runsById,
        }),
      ).toBe(true);
    },
  );
});
