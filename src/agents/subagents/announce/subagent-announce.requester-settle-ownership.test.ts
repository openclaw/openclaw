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
import {
  makeSettledChild as makeChild,
  publishWakeTransition,
} from "./subagent-announce.requester-settle-wake.test-support.js";

// mock-isolation: Ownership races supply settled descendants without opening session stores.
vi.mock("./subagent-announce.requester-settle-descendants.js", () => ({
  createRequesterDescendantReader: () => async () => ({ unsettled: false, active: 0 }),
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
  overrides: Parameters<typeof makeChild>[0],
  wake: Partial<RequesterSettleWakeState> = {},
) {
  return makeChild({
    runId: "run-b",
    ...overrides,
    requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1, ...wake },
  });
}

function completeBatch(batch: readonly SubagentRunRecord[], rearmGeneration?: number): void {
  for (const entry of batch) {
    if (entry.requesterSettleWake?.rearmGeneration === rearmGeneration) {
      entry.requesterSettleWake = undefined;
    }
  }
}

function holdDelivery() {
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
  return { admitted, execute, startedTurns };
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
    requesterTurnRunId,
    delivery: { status: "pending" },
    completion: { required: true, resultText: "watched steer result" },
  });
  const quietChild = makeSettledChild({
    runId: "run-a",
    requesterTurnRunId: "quiet-cancellation-owner",
    expectsCompletionMessage: false,
    completion: { required: false },
    delivery: { status: "not_required" },
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
  expect(published).toMatchObject({
    requesterSettleWake: { rearmGeneration: 2 },
    requesterTurnRunId: undefined,
  });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
    quietChild,
    copySubagentRunRuntimeOwner(published, { ...published }),
  ]);
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
  expect(deliverSpy).toHaveBeenCalledOnce();
  expect(quietChild.requesterTurnRunId).toBe("quiet-cancellation-owner");
});

it.each([
  { yielded: false, allDelivered: true },
  { yielded: false, allDelivered: false },
  { yielded: true, allDelivered: true },
  { yielded: true, allDelivered: false },
])(
  "does not repeat results consumed in a settle-wake turn (yielded=$yielded, allDelivered=$allDelivered)",
  async ({ yielded, allDelivered }) => {
    const requesterTurnRunId = `announce:requester-settle:main:${REQUESTER}:earlier-child:yield-1`;
    const children = ["run-a", "run-b"].map((runId, index) =>
      makeChild({
        runId,
        requesterTurnRunId,
        // These are the completion owner's confirmed in-turn delivery facts.
        delivery: { status: index === 0 || allDelivered ? "delivered" : "pending" },
        completion: { required: true, resultText: `retry result ${index}` },
      }),
    );
    const runs = new Map(children.map((child) => [child.runId, child]));
    registryRuntimeMock.listSubagentRunsForRequester.mockImplementation(() => [...runs.values()]);
    const requesterTurn = holdLiveRequesterTurns(requesterTurnRunId);
    const requester = {
      requesterSessionKey: REQUESTER,
      requesterTurnRunId,
      runs,
      transfer: createRequesterInitialTransferFixture(runs, vi.fn()),
    };
    try {
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      expect(deliverSpy).not.toHaveBeenCalled();
      if (yielded) {
        expect(await markRequesterTurnYieldedWithAuthority(requester)).toBe(2);
      }
      expect(
        await settleRequesterTurnAfterSessionSpawns({
          ...requester,
          requesterYielded: yielded,
          acceptedSessionSpawns: children.map((child) => ({
            runId: child.runId,
            childSessionKey: child.childSessionKey,
            expectsCompletionMessage: true,
          })),
          schedule: vi.fn(),
        }),
      ).toBe(true);
    } finally {
      requesterTurn.end(requesterTurnRunId);
      requesterTurn.restore();
    }
    // The delivery fixture mutates its snapshots; published registry rows are immutable.
    for (const [runId, child] of runs) {
      runs.set(runId, copySubagentRunRuntimeOwner(child, { ...child }));
    }

    const continuationOwed = yielded || !allDelivered;
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(continuationOwed);
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(continuationOwed ? 1 : 0);
    if (continuationOwed) {
      const call = deliverSpy.mock.calls[0]![0];
      expect(call.sourceTool).toBe("subagent_settle");
      expect(call.triggerMessage).not.toContain("retry result 0");
      expect(call.triggerMessage).toContain("Already delivered child results");
      if (allDelivered) {
        expect(call.triggerMessage).not.toContain("retry result 1");
      } else {
        expect(call.triggerMessage).toContain("retry result 1");
      }
    }
    expect([...runs.values()].every((child) => child.requesterSettleWake === undefined)).toBe(true);
  },
);

it.each(["same", "before admission", "during admission", "rearm"] as const)(
  "fences queued requester wakes across %s",
  async (replacement) => {
    const rearm = replacement === "rearm";
    const child = makeSettledChild(
      rearm
        ? {}
        : {
            requesterStorePath: "original-store",
            completion: { required: true, resultText: "retained child result" },
            delivery: { status: "suspended", suspendedReason: "permanent_failure" },
          },
      { requesterYieldBatch: true },
    );
    let current = child;
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
    if (!rearm) {
      publishSystemEventStoreResolver(() =>
        replacement === "before admission" ? "replacement-store" : "original-store",
      );
    }
    const { admitted, execute, startedTurns } = holdDelivery();
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
        if (rearm) {
          if (!child.requesterSettleWake) {
            throw new Error("The admitted requester wake must remain owned until it settles.");
          }
          current = copySubagentRunRuntimeOwner<SubagentRunRecord>(child, {
            ...child,
            requesterSettleWake: {
              ...child.requesterSettleWake,
              requesterYieldBatch: true,
              rearmGeneration: 2,
            },
          });
          registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([current]);
        } else {
          publishSystemEventStoreResolver(() =>
            replacement === "same" ? "original-store" : "replacement-store",
          );
        }
      }
      execute.resolve();
      expect(await pending).toBe(replacement === "same");
      expect(startedTurns).toEqual(replacement === "same" ? [REQUESTER] : []);
      if (rearm) {
        expect(current.requesterSettleWake).toMatchObject({ rearmGeneration: 2 });
        expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
        expect(current.requesterSettleWake).toBeUndefined();
      } else {
        expect(child).toMatchObject({
          requesterSettleWake: undefined,
          completion: { resultText: "retained child result" },
        });
      }
      if (!rearm && replacement !== "same") {
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
  const cancelled = makeSettledChild(
    {
      runId: "run-a",
      killReconciliation: { killedAt: 3_000, suppressTaskDelivery: true },
    },
    wake,
  );
  const completed = makeSettledChild(
    {
      completion: { required: true, resultText: "completed sibling result" },
    },
    wake,
  );
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([cancelled, completed]);
  // A suppressed member must not cancel its sibling's continuation.
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
  expect(deliverSpy).toHaveBeenCalledOnce();
  expect(completed).toMatchObject({
    requesterSettleWake: undefined,
    completion: { resultText: "completed sibling result" },
  });
});
