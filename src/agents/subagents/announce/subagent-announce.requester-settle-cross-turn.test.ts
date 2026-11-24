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

it("replays the same partial input even if a sibling finishes during backoff", async () => {
  vi.useFakeTimers();
  const batchRunIds = ["early", "late"];
  const wake = {
    status: "pending" as const,
    attemptCount: 0,
    requesterYieldBatch: true as const,
    rearmGeneration: 1,
    batchRunIds,
  };
  const early = makeSettledChild({
    runId: "early",
    delivery: { status: "pending" },
    requesterSettleWake: { ...wake },
  });
  const late = makeSettledChild({
    runId: "late",
    execution: { status: "running", startedAt: Date.now() },
    requesterSettleWake: { ...wake },
  });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([early, late]);
  deliverSpy.mockRejectedValueOnce(new Error("transport outcome unknown"));
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: early }))).toBe(
    false,
  );
  expect(early.requesterSettleWake).toMatchObject({
    status: "dispatching",
    attemptCount: 1,
    replayCount: 1,
    partitionRunIds: ["early"],
  });
  expect(late.requesterSettleWake).toEqual(wake);
  late.execution = { status: "terminal", endedAt: Date.now() };
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: late }))).toBe(
    false,
  );
  expect(deliverSpy).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: early }))).toBe(
    true,
  );
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: late }))).toBe(
    true,
  );
  const offered = deliverSpy.mock.calls.map(([call]) => [
    call.directIdempotencyKey,
    call.triggerMessage,
    call.settleWakeSourceSessionKeys,
  ]);
  expect(offered[0]).toEqual(offered[1]);
  expect(offered[2]?.[0]).not.toBe(offered[0]?.[0]);
  expect(offered[2]?.[2]).toEqual([late.childSessionKey]);
});

it.each([
  "older batch",
  "cross-agent descendant",
  "running member",
  "paused member",
  "message-wait member",
  "undelivered pending cleanup",
  "settled pending cleanup",
  "admitted message wait",
] as const)("waits only for owned work: %s", async (scenario) => {
  vi.useFakeTimers();
  const now = Date.now();
  const cleanup =
    scenario === "undelivered pending cleanup" || scenario === "settled pending cleanup";
  const admitted = scenario === "admitted message wait";
  const messageWait = scenario === "message-wait member" || admitted;
  const paused = scenario === "paused member" || messageWait;
  const sameBatch = scenario === "running member" || paused || cleanup;
  const crossAgent = scenario === "cross-agent descendant";
  const short = makeSettledChild({
    runId: "short",
    requesterAgentId: "main",
    ...(crossAgent ? { childSessionKey: "agent:research:subagent:short" } : {}),
    createdAt: now - 100,
    endedAt: now,
    ...(sameBatch && !cleanup ? { delivery: { status: "pending" } } : {}),
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
      paused || cleanup
        ? { status: "terminal", startedAt: now - 200, endedAt: now }
        : { status: "running", startedAt: now - 200 },
    ...(paused ? { pauseReason: "sessions_yield" as const } : {}),
    ...(messageWait ? { waitingForRequesterMessage: true as const } : {}),
    ...(scenario === "undelivered pending cleanup"
      ? { delivery: { status: "pending" as const } }
      : {}),
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
  const partial = scenario === "running member" || (paused && !admitted);
  const early = scenario === "older batch" || scenario === "settled pending cleanup" || partial;
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short }))).toBe(
    early,
  );
  expect(deliverSpy).toHaveBeenCalledTimes(early ? 1 : 0);
  if (partial) {
    expect(deliverSpy.mock.calls[0]?.[0]).toMatchObject({
      triggerMessage: expect.stringContaining("These are partial results"),
    });
    if (messageWait) {
      expect(deliverSpy.mock.calls[0]?.[0]?.triggerMessage).toContain("paused awaiting a message");
    }
    expect(short.requesterSettleWake).toBeUndefined();
    expect(long.requesterSettleWake).toMatchObject({
      attemptCount: 0,
      batchRunIds: ["short", "long"],
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
  if (scenario === "settled pending cleanup") {
    expect(short.requesterSettleWake).toBeUndefined();
    expect(long.requesterSettleWake).toBeUndefined();
    expect(long.cleanupCompletedAt).toBeUndefined();
    return;
  }
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
  }
});
