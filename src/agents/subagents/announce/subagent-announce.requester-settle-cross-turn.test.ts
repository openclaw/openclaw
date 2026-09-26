import { expect, it } from "vitest";
import { buildSubagentRunReadIndexFromRuns } from "../registry/subagent-registry-queries.js";
import {
  registryRuntimeMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";
import {
  REQUESTER,
  deliverSpy,
  makeSettledChild,
} from "./subagent-announce.requester-settle-wake.test-support.js";

it.each(["older batch", "own descendant", "same batch", "unfrozen"] as const)(
  "waits only for owned work: %s",
  async (scenario) => {
    const now = Date.now();
    const short = makeSettledChild({
      runId: "short",
      createdAt: now - 100,
      endedAt: now,
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
        ...(scenario === "unfrozen"
          ? {}
          : { batchRunIds: scenario === "same batch" ? ["short", "long"] : ["short"] }),
      },
    });
    const long = makeSettledChild({
      runId: "long",
      createdAt: now - 200,
      requesterSessionKey: scenario === "own descendant" ? short.childSessionKey : REQUESTER,
      execution: { status: "running", startedAt: now - 200 },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
        batchRunIds: scenario === "same batch" ? ["short", "long"] : ["long"],
      },
    });
    const runs = new Map([short, long].map((entry) => [entry.runId, entry]));
    const index = () => buildSubagentRunReadIndexFromRuns({ runs });
    registryRuntimeMock.listSubagentRunsForRequester.mockImplementation((key) =>
      [...runs.values()].filter((entry) => entry.requesterSessionKey === key),
    );
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockImplementation((key, exclude) =>
      index().hasDescendantRunAwaitingSettle(key, exclude),
    );
    registryRuntimeMock.countActiveDescendantRuns.mockImplementation((key) =>
      index().countActiveDescendantRuns(key),
    );
    const early = scenario === "older batch";
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short })),
    ).toBe(early);
    expect(deliverSpy).toHaveBeenCalledTimes(early ? 1 : 0);
    long.execution = { status: "terminal", startedAt: now - 200, endedAt: now + 1 };
    long.cleanupCompletedAt = now + 1;
    if (short.requesterSettleWake) {
      short.requesterSettleWake.nextAttemptAt = undefined;
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short })),
      ).toBe(true);
    } else {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: long })),
      ).toBe(true);
    }
    expect(deliverSpy).toHaveBeenCalledTimes(early ? 2 : 1);
  },
);
