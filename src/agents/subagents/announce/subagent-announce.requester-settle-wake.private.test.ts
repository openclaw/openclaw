import { beforeEach, describe, expect, it } from "vitest";
import { completionReader, visibleCompletion } from "./subagent-announce-fixtures.test-support.js";
import {
  registryRuntimeMock,
  findTranscriptEventMock,
  listedRequesterRuns,
  sessionStore,
  setSessionStore,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  REQUESTER,
  requesterSettleKey,
  deliverSpy,
  makeSettledChild,
  completeBatchSpy,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled private batches", () => {
  beforeEach(() => {
    findTranscriptEventMock.mockImplementation(
      completionReader((sessionId) =>
        listedRequesterRuns().find(
          (entry) => sessionStore[entry.childSessionKey]?.sessionId === sessionId,
        ),
      ),
    );
  });

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
        completion: visibleCompletion(index === 0 ? "private marker" : "public sibling"),
        requesterSettleWake: yielded
          ? {
              status: "pending",
              attemptCount: 0,
              afterRequesterYield: true,
              requesterYieldBatch: true,
              rearmGeneration: 1,
              ...(marked ? { yieldedFinalDeliverable: true as const } : {}),
            }
          : { status: "pending", attemptCount: 0 },
      }),
    );

  it.each([
    { name: "pending private pair", mixed: false, single: false, yielded: false },
    { name: "pending mixed pair", mixed: true, single: false, yielded: false },
    { name: "yielded private child", mixed: false, single: true, yielded: true },
    { name: "yielded mixed pair", mixed: true, single: false, yielded: true },
  ])("preserves the admitted reply policy: $name", async ({ mixed, single, yielded }) => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(
      settledPrivateChildren({ mixed, yielded, single }),
    );
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    const call = deliveredCallArg();
    expect(call.completionRequesterSessionId).toBe("sess-main");
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

  // The released yield writer stored private batches without the marker; after an
  // upgrade they keep their admitted private policy under the same stable identity.
  it.each([false, true])("preserves a batch's policy and identity (marked=%s)", async (marked) => {
    const children = settledPrivateChildren({ mixed: false, yielded: true, single: true, marked });
    children[0]!.requesterSettleWake!.batchRunIds = ["run-b"];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    const call = deliveredCallArg();
    expect(call.completionTarget).toBe(marked ? undefined : "parent");
    expect(call.directIdempotencyKey).toBe(requesterSettleKey("run-b:yield-1"));
    if (!marked) {
      expect(call.completionRequesterSessionId).toBe("sess-main");
    }
  });

  // `/new` keeps the session id and rotates its lifecycle revision. A deliverable
  // retry after either replacement would post the old findings into a fresh session.
  it.each([
    { name: "new session id", current: { sessionId: "new-parent" } },
    { name: "reset lifecycle", current: { sessionId: "sess-main", lifecycleRevision: "rev-2" } },
  ])(
    "does not pass private findings to a replacement requester incarnation: $name",
    async ({ current }) => {
      setSessionStore({ [REQUESTER]: current });
      const children = settledPrivateChildren({ mixed: false, yielded: true, single: true });
      children[0]!.requesterSettleWake!.batchRunIds = ["run-b"];
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
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
