import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import { settleRequesterTurnAfterSessionSpawns } from "../registry/subagent-registry-requester-yield.js";
import {
  createRequesterInitialTransferFixture,
  markRequesterTurnYieldedWithAuthority,
} from "../registry/subagent-registry-requester-yield.test-support.js";
import type {
  RequesterSettleWakeState,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";
import { holdLiveRequesterTurns } from "../registry/subagent-requester-turn-liveness.test-support.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import * as announceOutput from "./subagent-announce-output.js";
import type { createRequesterDescendantReader } from "./subagent-announce.requester-settle-descendants.js";
import { publishWakeTransition } from "./subagent-announce.requester-settle-wake.test-support.js";

const readDescendantFacts = vi.hoisted(() =>
  vi.fn<
    (
      params: Parameters<typeof createRequesterDescendantReader>[0],
    ) => ReturnType<ReturnType<typeof createRequesterDescendantReader>>
  >(async () => ({ unsettled: false, active: 0 })),
);

vi.mock("./subagent-announce.requester-settle-descendants.js", () => ({
  createRequesterDescendantReader:
    (params: Parameters<typeof createRequesterDescendantReader>[0]) => () =>
      readDescendantFacts(params),
}));

const { registryRuntimeMock, deliverSpy } = vi.hoisted(() => ({
  registryRuntimeMock: {
    listSubagentRunsForRequester: vi.fn<() => SubagentRunRecord[]>(() => []),
    getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
    getLatestLiveSubagentRunByChildSessionKey: vi.fn(() => undefined),
  },
  deliverSpy: vi.fn<(params: Record<string, unknown>) => Promise<SubagentAnnounceDeliveryResult>>(),
}));

vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../registry/subagent-registry-read.js", () => registryRuntimeMock);
// mock-isolation: This fixture controls requester depth without a session database.
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
  getSubagentDepthFromSessionStoreInWorker: async () => 0,
}));
// mock-isolation: Ownership races hold the fixture delivery receipt and requester identity without real delivery or database reads.
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: () => ({
    entry: { sessionId: "sess-main" },
    canonicalKey: "agent:main:main",
    cfg: {},
    agentId: "main",
    storePath: "/synthetic/requester-settle.sqlite",
  }),
}));

import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

const REQUESTER = "agent:main:main";
const readChildCompletionFindings = announceOutput.readChildCompletionFindings;

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
  return {
    requesterSessionKey: REQUESTER,
    settledEntry,
    completeBatch,
    transitionBatch: publishWakeTransition,
    isSourceCurrent: () => true,
  };
}

beforeEach(() => {
  vi.spyOn(deliveryRuntime, "captureRequesterSessionEntryCurrent").mockResolvedValue({
    readCurrent: () => ({ sessionId: "sess-main" }),
    release() {},
  });
  vi.spyOn(announceOutput, "readChildCompletionFindings").mockImplementation((children) =>
    readChildCompletionFindings(children, (runId) =>
      registryRuntimeMock.listSubagentRunsForRequester().find((entry) => entry.runId === runId),
    ),
  );
  readDescendantFacts.mockReset().mockResolvedValue({ unsettled: false, active: 0 });
  registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
  deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
});
afterEach(() => {
  vi.mocked(deliveryRuntime.captureRequesterSessionEntryCurrent).mockRestore();
  vi.mocked(announceOutput.readChildCompletionFindings).mockRestore();
  publishSystemEventStoreResolver(undefined);
});

it("holds an adopted child's old wake until its current requester turn yields", async () => {
  const requesterTurnRunId = "watched-steer-requester";
  const child = makeSettledChild({
    runId: "run-b",
    requesterTurnRunId,
    delivery: { status: "pending" },
    completion: { required: true, resultText: "watched steer result" },
    requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
  });
  const quietChild = makeSettledChild({
    runId: "run-a",
    requesterTurnRunId: "quiet-cancellation-owner",
    expectsCompletionMessage: false,
    completion: { required: false },
    delivery: { status: "not_required" },
    requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
  });
  const oldWake = structuredClone(child.requesterSettleWake);
  const requesterTurn = holdLiveRequesterTurns(requesterTurnRunId);
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([quietChild, child]);
  expect(
    await maybeWakeRequesterAfterAllChildrenSettled({ ...wakeParams(), settledEntry: quietChild }),
  ).toBe(false);
  expect(deliverSpy).not.toHaveBeenCalled();
  expect(child.requesterSettleWake).toEqual(oldWake);

  const runs = new Map([
    [quietChild.runId, quietChild],
    [child.runId, child],
  ]);
  const requester = {
    requesterSessionKey: REQUESTER,
    requesterTurnRunId,
    runs,
    transfer: createRequesterInitialTransferFixture(runs, vi.fn()),
  };
  expect(await markRequesterTurnYieldedWithAuthority(requester)).toBe(1);
  expect(
    await settleRequesterTurnAfterSessionSpawns({
      ...requester,
      requesterYielded: true,
      acceptedSessionSpawns: [
        {
          runId: child.runId,
          childSessionKey: child.childSessionKey,
          expectsCompletionMessage: true,
        },
      ],
      schedule: vi.fn(),
    }),
  ).toBe(true);
  requesterTurn.end(requesterTurnRunId);
  // Settlement rearms the adopted wake for the new turn's complete child batch.
  const published = runs.get(child.runId)!;
  expect(published.requesterSettleWake?.rearmGeneration).toBe(2);
  expect(published.requesterTurnRunId).toBeUndefined();
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
    quietChild,
    copySubagentRunRuntimeOwner(published, { ...published }),
  ]);
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
  expect(deliverSpy).toHaveBeenCalledOnce();
  expect(quietChild.requesterTurnRunId).toBe("quiet-cancellation-owner");
});

it.each(["same", "before admission", "during admission"] as const)(
  "keeps yielded requester wakes in their captured store: %s",
  async (replacement) => {
    const child = makeSettledChild({
      runId: "run-b",
      requesterStorePath: "original-store",
      completion: { required: true, resultText: "retained child result" },
      delivery: { status: "suspended", suspendedReason: "permanent_failure" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
    publishSystemEventStoreResolver(() =>
      replacement === "before admission" ? "replacement-store" : "original-store",
    );
    const admitted = createDeferred();
    const execute = createDeferred();
    const startedTurns: string[] = [];
    deliverSpy.mockImplementationOnce(async (params) => {
      admitted.resolve();
      await execute.promise;
      const allowed = params.isSourceSessionEffectsAllowed;
      if (typeof allowed === "function" && !allowed()) {
        return { delivered: false, path: "none", disposition: "intentional_non_delivery" };
      }
      startedTurns.push(REQUESTER);
      return { delivered: true, path: "direct" };
    });
    const complete = vi.fn((batch: readonly SubagentRunRecord[], generation?: number) =>
      completeBatch(batch, generation),
    );
    const pending = maybeWakeRequesterAfterAllChildrenSettled({
      ...wakeParams(),
      completeBatch: complete,
    });
    try {
      if (replacement !== "before admission") {
        await awaitGateBeforeSettlement(
          admitted.promise,
          pending,
          "Requester delivery settled before reaching admission",
        );
        publishSystemEventStoreResolver(() =>
          replacement === "same" ? "original-store" : "replacement-store",
        );
      }
      execute.resolve();
      expect(await pending).toBe(replacement === "same");
      expect(startedTurns).toEqual(replacement === "same" ? [REQUESTER] : []);
      expect(child.requesterSettleWake).toBeUndefined();
      expect(child.completion?.resultText).toBe("retained child result");
      if (replacement !== "same") {
        expect(complete).toHaveBeenCalledWith(
          [child],
          1,
          expect.objectContaining({
            error: "store replaced",
            disposition: "intentional_non_delivery",
          }),
          expect.any(Function),
        );
      }
    } finally {
      execute.resolve();
      await pending;
    }
  },
);

it("excludes a suppressed member while its completed sibling still delivers once", async () => {
  const batchRunIds = ["run-a", "run-b"];
  const wake: RequesterSettleWakeState = {
    status: "pending",
    attemptCount: 0,
    batchRunIds,
    requesterYieldBatch: true,
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
  // Requester reset retires every child through its own event; a suppressed member
  // alone retires only itself and cannot hold or cancel its sibling's continuation.
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
  expect(deliverSpy).toHaveBeenCalledOnce();
  expect(completed.requesterSettleWake).toBeUndefined();
  expect(completed.completion?.resultText).toBe("completed sibling result");
});

it("leaves a yielded batch intact when an older queued wake loses rearm authority", async () => {
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
    await awaitGateBeforeSettlement(
      admitted.promise,
      pending,
      "Requester delivery settled before reaching admission",
    );
    if (!child.requesterSettleWake) {
      throw new Error("The admitted requester wake must remain owned until it settles.");
    }
    const advanced = copySubagentRunRuntimeOwner<SubagentRunRecord>(child, {
      ...child,
      requesterSettleWake: {
        ...child.requesterSettleWake,
        requesterYieldBatch: true,
        rearmGeneration: 2,
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([advanced]);
    execute.resolve();
    expect(await pending).toBe(false);
    expect(startedTurns).toEqual([]);
    expect(advanced.requesterSettleWake).toMatchObject({ rearmGeneration: 2 });
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(advanced.requesterSettleWake).toBeUndefined();
  } finally {
    execute.resolve();
    await pending;
  }
});
