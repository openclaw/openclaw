import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  countActiveDescendantRunsFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
} from "../registry/subagent-registry-queries.js";
import {
  registryRuntimeMock,
  readDescendantFacts,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";
import {
  REQUESTER,
  deliverSpy,
  makeSettledChild,
} from "./subagent-announce.requester-settle-wake.test-support.js";

beforeEach(() => {
  setRuntimeConfigSnapshot({ session: { mainKey: "main", scope: "per-sender" } });
});

afterEach(() => {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
});

it.each([
  "older batch",
  "cross-agent descendant",
  "paused member",
  "message wait",
  "admitted message wait",
  "undelivered pending cleanup",
] as const)("waits only for owned work: %s", async (scenario) => {
  vi.useFakeTimers();
  const now = Date.now();
  const admitted = scenario === "admitted message wait";
  const messageWait = scenario === "message wait" || admitted;
  const paused = scenario === "paused member" || messageWait;
  const sameBatch = paused || scenario === "undelivered pending cleanup";
  const crossAgent = scenario === "cross-agent descendant";
  const short = makeSettledChild({
    runId: "short",
    requesterAgentId: "main",
    ...(crossAgent ? { childSessionKey: "agent:research:subagent:short" } : {}),
    createdAt: now - 100,
    endedAt: now,
    requesterSettleWake: {
      status: "pending",
      attemptCount: admitted ? 1 : 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: sameBatch ? ["short", "long"] : ["short"],
    },
  });
  const long = makeSettledChild({
    runId: "long",
    requesterAgentId: crossAgent ? "research" : "main",
    ...(crossAgent ? { requesterStorePath: "/research/sessions.json" } : {}),
    createdAt: now - 200,
    requesterSessionKey: crossAgent ? short.childSessionKey : REQUESTER,
    execution:
      paused || scenario === "undelivered pending cleanup"
        ? { status: "terminal", startedAt: now - 200, endedAt: now }
        : { status: "running", startedAt: now - 200 },
    ...(scenario === "undelivered pending cleanup"
      ? { delivery: { status: "pending" as const } }
      : {}),
    ...(paused ? { pauseReason: "sessions_yield" as const } : {}),
    ...(messageWait ? { waitingForRequesterMessage: true as const } : {}),
    requesterSettleWake: {
      status: "pending",
      attemptCount: admitted ? 1 : 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: sameBatch ? ["short", "long"] : ["long"],
    },
  });
  const runs = new Map([short, long].map((entry) => [entry.runId, entry]));
  registryRuntimeMock.listSubagentRunsForRequester.mockImplementation((key) =>
    [...runs.values()].filter((entry) => entry.requesterSessionKey === key),
  );
  readDescendantFacts.mockImplementation(async (params) => ({
    unsettled: hasDescendantRunAwaitingSettleFromRuns(
      runs,
      params.requesterSessionKey,
      params.settledEntry.runId,
      params.requesterAgentId,
      params.requesterStorePath,
      params.settledBefore,
      params.rootRunIds,
    ),
    active: countActiveDescendantRunsFromRuns(
      runs,
      params.requesterSessionKey,
      params.requesterAgentId,
      params.requesterStorePath,
      params.rootRunIds,
    ),
  }));
  const early = scenario === "older batch" || (messageWait && !admitted);
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short }))).toBe(
    early,
  );
  expect(deliverSpy).toHaveBeenCalledTimes(early ? 1 : 0);
  if (admitted) {
    expect(short.requesterSettleWake?.attemptCount).toBe(1);
    expect(long.requesterSettleWake?.attemptCount).toBe(1);
  } else if (messageWait) {
    expect(deliverSpy.mock.calls[0]?.[0]?.settleWakeSourceSessionKeys).toEqual([
      short.childSessionKey,
    ]);
    expect(deliverSpy.mock.calls[0]?.[0]?.triggerMessage).toContain("paused awaiting a message");
    expect(long.requesterSettleWake).toMatchObject({
      status: "pending",
      attemptCount: 0,
      rearmGeneration: 1,
    });
  }
  if (crossAgent) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await vi.advanceTimersByTimeAsync(30_001);
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short }));
    }
    expect(short.requesterSettleWake?.status).toBe("pending");
    expect(deliverSpy).not.toHaveBeenCalled();
  }
  long.execution = { status: "terminal", startedAt: now - 200, endedAt: now + 1 };
  long.pauseReason = undefined;
  long.waitingForRequesterMessage = undefined;
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
  if (admitted) {
    expect(deliverSpy.mock.calls[0]?.[0]?.settleWakeSourceSessionKeys).toEqual(
      expect.arrayContaining([short.childSessionKey, long.childSessionKey]),
    );
  } else if (messageWait) {
    expect(deliverSpy.mock.calls[1]?.[0]?.settleWakeSourceSessionKeys).toEqual([
      long.childSessionKey,
    ]);
  }
});
