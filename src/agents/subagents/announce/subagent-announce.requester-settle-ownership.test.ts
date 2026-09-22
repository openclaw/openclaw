import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const { registryRuntimeMock, deliverSpy } = vi.hoisted(() => ({
  registryRuntimeMock: {
    countActiveDescendantRuns: vi.fn(() => 0),
    hasDescendantRunAwaitingSettle: vi.fn(() => false),
    listSubagentRunsForRequester: vi.fn<() => SubagentRunRecord[]>(() => []),
    getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
    getLatestLiveSubagentRunByChildSessionKey: vi.fn(() => undefined),
  },
  deliverSpy: vi.fn<(params: Record<string, unknown>) => Promise<SubagentAnnounceDeliveryResult>>(),
}));

vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../registry/subagent-registry-read.js", () => registryRuntimeMock);
vi.mock("../spawn/subagent-depth.js", () => ({ getSubagentDepthFromSessionStore: () => 0 }));
vi.mock("./subagent-announce.js", () => ({ hasUsableSessionEntry: () => true }));
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: () => ({
    entry: { sessionId: "sess-main" },
    canonicalKey: "agent:main:main",
  }),
}));

import {
  maybeWakeRequesterAfterAllChildrenSettled,
  type RequesterSettleWakeBatchState,
} from "./subagent-announce.requester-settle-wake.js";

const REQUESTER = "agent:main:main";

function makeSettledChild(
  overrides: Pick<SubagentRunRecord, "runId"> & Partial<SubagentRunRecord>,
): SubagentRunRecord {
  const { runId, ...record } = overrides;
  return {
    runId,
    childSessionKey: "agent:main:subagent:" + runId,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
    ...record,
  };
}

function transitionBatch(
  batch: readonly SubagentRunRecord[],
  state: RequesterSettleWakeBatchState,
): void {
  for (const entry of batch) {
    if (entry.requesterSettleWake) {
      entry.requesterSettleWake = {
        ...state,
        ...(entry.requesterSettleWake.retireAfterSettle ? { retireAfterSettle: true } : {}),
      };
    }
  }
}

function completeBatch(batch: readonly SubagentRunRecord[], rearmGeneration?: number): void {
  for (const entry of batch) {
    if (entry.requesterSettleWake?.rearmGeneration === rearmGeneration) {
      entry.requesterSettleWake = undefined;
    }
  }
}

function wakeParams() {
  const settledEntry = registryRuntimeMock
    .listSubagentRunsForRequester()
    .find((entry) => entry.runId === "run-b");
  if (!settledEntry) {
    throw new Error("The control requires its registered run-b fixture.");
  }
  return { requesterSessionKey: REQUESTER, settledEntry, transitionBatch, completeBatch };
}

beforeEach(() => {
  registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
  deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
});

it("closes the frozen requester obligation when reset suppresses an unfinished member", async () => {
  const batchRunIds = ["run-a", "run-b"];
  const wake = {
    status: "pending" as const,
    attemptCount: 0,
    batchRunIds,
    requesterYieldBatch: true as const,
    rearmGeneration: 7,
  };
  const cancelled = makeSettledChild({
    runId: "run-a",
    requesterSettleWake: { ...wake },
    killReconciliation: { killedAt: 3_000, suppressTaskDelivery: true },
  });
  // Reset leaves completed records intact, but their shared requester was stopped.
  const completed = makeSettledChild({
    runId: "run-b",
    requesterSettleWake: { ...wake },
    completion: { required: true, resultText: "completed sibling result" },
  });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([cancelled, completed]);
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
  expect(deliverSpy).not.toHaveBeenCalled();
  expect(cancelled.requesterSettleWake).toBeUndefined();
  expect(completed.requesterSettleWake).toBeUndefined();
  expect(completed.completion?.resultText).toBe("completed sibling result");
});

it("leaves a rearmed yielded batch intact when an older queued wake loses authority", async () => {
  const child = makeSettledChild({
    runId: "run-b",
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
    },
  });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
  const admitted = createDeferred();
  const execute = createDeferred();
  const startedTurns: string[] = [];
  deliverSpy.mockImplementationOnce(async (params) => {
    admitted.resolve();
    await execute.promise;
    const allowed = params.isSourceSessionEffectsAllowed;
    if (typeof allowed === "function" && !allowed()) {
      return {
        delivered: false,
        path: "none",
        disposition: "intentional_non_delivery",
      };
    }
    startedTurns.push(REQUESTER);
    return { delivered: true, path: "direct" };
  });
  const pending = maybeWakeRequesterAfterAllChildrenSettled(wakeParams());
  try {
    await admitted.promise;
    transitionBatch([child], {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 2,
    });
    execute.resolve();
    expect(await pending).toBe(false);
    expect(startedTurns).toEqual([]);
    expect(child.requesterSettleWake).toMatchObject({
      status: "pending",
      attemptCount: 0,
      rearmGeneration: 2,
    });
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(child.requesterSettleWake).toBeUndefined();
  } finally {
    execute.resolve();
    await pending;
  }
});
