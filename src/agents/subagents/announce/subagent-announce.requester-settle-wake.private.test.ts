// Private completion batches: session binding and yielded-final delivery policy.
import { describe, expect, it } from "vitest";
import {
  registryRuntimeMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
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
  }: {
    mixed: boolean;
    yielded: boolean;
    single: boolean;
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
            ? { afterRequesterYield: true, requesterYieldBatch: true, rearmGeneration: 1 }
            : {}),
        },
      }),
    );

  it.each([
    { name: "delivered private pair", mixed: false },
    { name: "delivered mixed pair", mixed: true },
  ])("keeps settled private results internal: $name", async ({ mixed }) => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(
      settledPrivateChildren({ mixed, yielded: false, single: false }),
    );
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(deliveredCallArg()).toMatchObject({
      completionTarget: "parent",
      completionRequesterSessionId: "sess-main",
      requireDirectDelivery: true,
    });
    expect(deliveredCallArg().requireVisibleReply).toBeUndefined();
    expect(String(deliveredCallArg().triggerMessage)).toContain("private marker");
    expect(String(deliveredCallArg().triggerMessage)).toContain(
      "send it through an available, permitted messaging tool",
    );
    expect(String(deliveredCallArg().triggerMessage)).toContain(
      "when no further work or user-facing update is owed, or after sending that update",
    );
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(completeBatchSpy.mock.calls[0]?.[2]).not.toHaveProperty(
      "requesterVisibleFinalDelivered",
    );
  });

  // A yield hands continuation back to the requester. A private continuation
  // cannot deliver, so its final answer would be discarded silently.
  it.each([
    { name: "yielded private child", mixed: false, single: true },
    { name: "yielded mixed pair", mixed: true, single: false },
  ])("resumes a yielded requester with a deliverable reply: $name", async ({ mixed, single }) => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(
      settledPrivateChildren({ mixed, yielded: true, single }),
    );
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(deliveredCallArg()).toMatchObject({
      requireDirectDelivery: true,
      completionRequesterSessionId: "sess-main",
    });
    expect(deliveredCallArg().completionTarget).toBeUndefined();
    // Deliverable, not forced: NO_REPLY stays silent when nothing is owed.
    expect(deliveredCallArg().requireVisibleReply).toBeUndefined();
    const trigger = String(deliveredCallArg().triggerMessage);
    expect(trigger).toContain("private marker");
    expect(trigger).not.toContain("Your final reply stays internal");
    expect(trigger).toContain("Your final reply is delivered to the original conversation");
    expect(trigger).toContain("when no user-facing update is owed");
    expect(transitionBatchSpy.mock.calls.at(0)?.[1]).toMatchObject({
      status: "dispatching",
      yieldedFinalDeliverable: true,
    });
  });

  it.each(["dispatching", "pending"] as const)(
    "keeps the private policy for a %s batch already attempted without the marker",
    async (status) => {
      const children = settledPrivateChildren({ mixed: false, yielded: true, single: true });
      Object.assign(children[0]!.requesterSettleWake!, {
        status,
        attemptCount: 1,
        batchRunIds: ["run-b"],
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
      expect(deliveredCallArg()).toMatchObject({
        completionTarget: "parent",
        completionRequesterSessionId: "sess-main",
      });
      // Private inputs keep the unsuffixed identity across attempts.
      expect(deliveredCallArg().directIdempotencyKey).toBe(requesterSettleKey("run-b:yield-1"));
    },
  );

  it("keeps the deliverable policy for a marked batch after a failed attempt", async () => {
    const children = settledPrivateChildren({ mixed: false, yielded: true, single: true });
    Object.assign(children[0]!.requesterSettleWake!, {
      status: "pending",
      attemptCount: 1,
      batchRunIds: ["run-b"],
      yieldedFinalDeliverable: true,
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(deliveredCallArg().completionTarget).toBeUndefined();
    // A deliverable retry needs a fresh key: the Gateway caches terminal outcomes
    // per key, so reusing the first attempt's key would replay its failure.
    expect(deliveredCallArg().directIdempotencyKey).toBe(
      requesterSettleKey("run-b:yield-1:retry-1"),
    );
    expect(transitionBatchSpy.mock.calls.at(0)?.[1]).toMatchObject({
      status: "dispatching",
      yieldedFinalDeliverable: true,
    });
  });

  it("does not pass private findings to a replacement requester incarnation", async () => {
    const child = makeSettledChild({
      runId: "run-b",
      completionTarget: "parent",
      completionRequesterSessionId: "old-parent",
      delivery: { status: "pending" },
      completion: { required: true, resultText: "private marker" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenCalledWith(
      ["run-b"],
      undefined,
      expect.objectContaining({
        delivered: false,
        reason: "completion_handoff_unavailable",
        disposition: "intentional_non_delivery",
      }),
    );
  });
});
