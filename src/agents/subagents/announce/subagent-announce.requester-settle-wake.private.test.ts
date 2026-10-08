// Private completion batches: session binding and yielded-final delivery policy.
import { describe, expect, it } from "vitest";
import {
  registryRuntimeMock,
  setSessionStore,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  REQUESTER,
  requesterSettleKey,
  deliverSpy,
  makeSettledChild,
  transitionBatchSpy,
  completeBatchSpy,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled private batches", () => {
  const settledPrivateChildren = ({
    mixed,
    yielded,
    single,
    marked = true,
  }: {
    mixed: boolean;
    yielded: boolean;
    single: boolean;
    marked?: boolean;
  }) =>
    (single ? ["run-b"] : ["run-a", "run-b"]).map((runId, index) =>
      makeSettledChild({
        runId,
        ...(!mixed || index === 0
          ? { completionTarget: "parent" as const, completionRequesterSessionId: "sess-main" }
          : {}),
        completion: {
          required: true,
          resultText: index === 0 ? "private marker" : "public sibling",
        },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          ...(yielded
            ? {
                afterRequesterYield: true,
                requesterYieldBatch: true,
                rearmGeneration: 1,
                ...(marked ? { yieldedFinalDeliverable: true as const } : {}),
              }
            : {}),
        },
      }),
    );

  it.each([
    { name: "delivered private pair", mixed: false, single: false, yielded: false },
    { name: "delivered mixed pair", mixed: true, single: false, yielded: false },
    { name: "yielded private child", mixed: false, single: true, yielded: true },
    { name: "yielded mixed pair", mixed: true, single: false, yielded: true },
  ])("preserves the admitted reply policy: $name", async ({ mixed, single, yielded }) => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(
      settledPrivateChildren({ mixed, yielded, single }),
    );
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    const call = deliveredCallArg();
    expect(call).toMatchObject({
      completionRequesterSessionId: "sess-main",
      requireDirectDelivery: true,
    });
    // The conversation's reply policy decides whether a visible update is owed.
    expect(call.requireVisibleReply).toBeUndefined();
    expect(call.completionTarget).toBe(yielded ? undefined : "parent");
    const trigger = String(call.triggerMessage);
    expect(trigger).toContain("private marker");
    if (yielded) {
      expect(trigger).not.toContain("Your final reply stays internal");
      expect(trigger).toContain("under its normal reply rules");
      expect(trigger).toContain("must go through the message tool, send your answer with it");
      expect(trigger).toContain("avoid repeating an update already delivered");
      expect(transitionBatchSpy.mock.calls.at(0)?.[1]).toMatchObject({
        status: "dispatching",
        yieldedFinalDeliverable: true,
      });
    } else {
      expect(trigger).toContain("send it through an available, permitted messaging tool");
      expect(trigger).toContain("briefly record the reviewed outcome and any remaining work");
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      expect(deliverSpy).toHaveBeenCalledOnce();
      expect(completeBatchSpy.mock.calls[0]?.[2]).not.toHaveProperty(
        "requesterVisibleFinalDelivered",
      );
    }
  });

  // The released yield writer stored private batches without the marker, including
  // unattempted ones; after an upgrade they keep their admitted private policy.
  it.each([
    { status: "dispatching", attemptCount: 1, marked: false },
    { status: "pending", attemptCount: 1, marked: false },
    { status: "pending", attemptCount: 0, marked: false },
    { status: "pending", attemptCount: 1, marked: true },
  ] as const)(
    "preserves a $status batch's policy and retry identity (marked=$marked, attempts=$attemptCount)",
    async ({ status, attemptCount, marked }) => {
      const children = settledPrivateChildren({
        mixed: false,
        yielded: true,
        single: true,
        marked,
      });
      children[0]!.requesterSettleWake = {
        ...children[0]!.requesterSettleWake!,
        status,
        attemptCount,
        batchRunIds: ["run-b"],
      };
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
      const call = deliveredCallArg();
      expect(call.completionTarget).toBe(marked ? undefined : "parent");
      // Deliverable retries rotate keys; private inputs retain their admitted identity.
      expect(call.directIdempotencyKey).toBe(
        requesterSettleKey(marked ? "run-b:yield-1:retry-1" : "run-b:yield-1"),
      );
      if (marked) {
        expect(transitionBatchSpy.mock.calls.at(0)?.[1]).toMatchObject({
          status: "dispatching",
          yieldedFinalDeliverable: true,
        });
      } else {
        expect(call.completionRequesterSessionId).toBe("sess-main");
      }
    },
  );

  // `/new` keeps the session id and rotates its lifecycle revision. A deliverable
  // retry after either replacement would post the old findings into a fresh session.
  it.each([
    { name: "new session id", current: { sessionId: "new-parent" } },
    { name: "reset lifecycle", current: { sessionId: "sess-main", lifecycleRevision: "rev-2" } },
  ])(
    "does not pass private findings to a replacement requester incarnation: $name",
    async ({ current }) => {
      setSessionStore({ [REQUESTER]: current });
      const child = makeSettledChild({
        runId: "run-b",
        completionTarget: "parent",
        completionRequesterSessionId: "sess-main",
        delivery: { status: "pending" },
        completion: { required: true, resultText: "private marker" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 1,
          batchRunIds: ["run-b"],
          afterRequesterYield: true,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          yieldedFinalDeliverable: true,
        },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      expect(deliverSpy).not.toHaveBeenCalled();
      expect(completeBatchSpy).toHaveBeenCalledWith(
        ["run-b"],
        expect.anything(),
        expect.objectContaining({
          delivered: false,
          reason: "completion_handoff_unavailable",
          disposition: "intentional_non_delivery",
        }),
      );
    },
  );
});
