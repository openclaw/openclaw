import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  buildScopedSubagentRunReadIndexFromRuns,
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

it.each(["older batch", "cross-agent descendant", "paused member", "pending cleanup"] as const)(
  "waits only for owned work: %s",
  async (scenario) => {
    vi.useFakeTimers();
    const now = Date.now();
    const sameBatch = ["paused member", "pending cleanup"].includes(scenario);
    const crossAgent = scenario === "cross-agent descendant";
    const short = makeSettledChild({
      runId: "short",
      requesterAgentId: "main",
      ...(crossAgent ? { childSessionKey: "agent:research:subagent:short" } : {}),
      createdAt: now - 100,
      endedAt: now,
      completion: { required: true, terminalReply: { disposition: "empty" } },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
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
      completion: { required: true, terminalReply: { disposition: "empty" } },
      execution:
        scenario === "paused member" || scenario === "pending cleanup"
          ? { status: "terminal", startedAt: now - 200, endedAt: now }
          : { status: "running", startedAt: now - 200 },
      ...(scenario === "paused member" ? { pauseReason: "sessions_yield" as const } : {}),
      ...(scenario === "pending cleanup" ? { delivery: { status: "pending" as const } } : {}),
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
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
      deliveryWaitUntil: now + 300_000,
      unsettled: hasDescendantRunAwaitingSettleFromRuns(
        runs,
        params.requesterSessionKey,
        params.settledEntry.runId,
        params.requesterAgentId,
        params.requesterStorePath,
        params.settledBefore,
        params.rootRunIds,
      ),
      active: buildScopedSubagentRunReadIndexFromRuns(
        runs,
        params.requesterSessionKey,
        params.requesterAgentId,
        params.requesterStorePath,
        params.rootRunIds,
      ).countActiveDescendantRuns(params.requesterSessionKey),
    }));
    const early = scenario === "older batch";
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short })),
    ).toBe(early);
    expect(deliverSpy).toHaveBeenCalledTimes(early ? 1 : 0);
    if (crossAgent) {
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: short }));
      expect(short.requesterSettleWake).toBeDefined();
      expect(deliverSpy).not.toHaveBeenCalled();
    }
    long.execution = { status: "terminal", startedAt: now - 200, endedAt: now + 1 };
    long.pauseReason = undefined;
    long.cleanupCompletedAt = now + 1;
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
  },
);
