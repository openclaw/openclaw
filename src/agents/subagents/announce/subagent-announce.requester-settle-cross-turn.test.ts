import { expect, it } from "vitest";
import {
  buildSubagentRunReadIndexFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
} from "../registry/subagent-registry-queries.js";
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

it.each([
  "older batch",
  "own descendant",
  "same batch",
  "paused member",
  "pending cleanup",
  "unfrozen",
] as const)("waits only for owned work: %s", async (scenario) => {
  const now = Date.now();
  const sameBatch = ["same batch", "paused member", "pending cleanup"].includes(scenario);
  const short = makeSettledChild({
    runId: "short",
    requesterAgentId: "main",
    createdAt: now - 100,
    endedAt: now,
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      ...(scenario === "unfrozen"
        ? {}
        : { batchRunIds: sameBatch ? ["short", "long"] : ["short"] }),
    },
  });
  const long = makeSettledChild({
    runId: "long",
    requesterAgentId: "main",
    createdAt: now - 200,
    requesterSessionKey: scenario === "own descendant" ? short.childSessionKey : REQUESTER,
    execution:
      scenario === "paused member" || scenario === "pending cleanup"
        ? { status: "terminal", startedAt: now - 200, endedAt: now }
        : { status: "running", startedAt: now - 200 },
    ...(scenario === "paused member" ? { pauseReason: "sessions_yield" as const } : {}),
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: sameBatch ? ["short", "long"] : ["long"],
    },
  });
  const runs = new Map([short, long].map((entry) => [entry.runId, entry]));
  const index = () => buildSubagentRunReadIndexFromRuns({ runs });
  registryRuntimeMock.listSubagentRunsForRequester.mockImplementation((key) =>
    [...runs.values()].filter((entry) => entry.requesterSessionKey === key),
  );
  registryRuntimeMock.hasDescendantRunAwaitingSettle.mockImplementation((...args) =>
    hasDescendantRunAwaitingSettleFromRuns(runs, ...args),
  );
  registryRuntimeMock.countActiveDescendantRuns.mockImplementation((key) =>
    index().countActiveDescendantRuns(key),
  );
  const early = scenario === "older batch";
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short }))).toBe(
    early,
  );
  expect(deliverSpy).toHaveBeenCalledTimes(early ? 1 : 0);
  long.execution = { status: "terminal", startedAt: now - 200, endedAt: now + 1 };
  long.pauseReason = undefined;
  long.cleanupCompletedAt = now + 1;
  for (const entry of runs.values()) {
    if (entry.requesterSettleWake) {
      entry.requesterSettleWake.nextAttemptAt = undefined;
    }
  }
  if (short.requesterSettleWake) {
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short })),
    ).toBe(true);
  } else {
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: long })),
    ).toBe(true);
  }
  expect(deliverSpy).toHaveBeenCalledTimes(early ? 2 : 1);
});
