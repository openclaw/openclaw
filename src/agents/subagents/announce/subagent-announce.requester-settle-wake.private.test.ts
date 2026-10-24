import { describe, expect, it } from "vitest";
import {
  privateRequesterRouteCases,
  visibleCompletion,
} from "./subagent-announce-fixtures.test-support.js";
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
  completeBatchSpy,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled private batches", () => {
  type PrivateOptions = Partial<Record<"mixed" | "yielded" | "single" | "marked", boolean>>;
  const settledPrivateChildren = ({ mixed, yielded, single, marked = true }: PrivateOptions) => {
    const children = (single ? ["run-b"] : ["run-a", "run-b"]).map((runId, index) =>
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
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    return children;
  };

  type Scenario = PrivateOptions & {
    name: string;
    current?: { sessionId: string; lifecycleRevision?: string };
    frozen?: boolean;
  };
  it.each<Scenario>([
    { name: "pending private pair" },
    { name: "pending mixed pair", mixed: true },
    { name: "yielded private child", single: true, yielded: true },
    { name: "yielded mixed pair", mixed: true, yielded: true },
    { name: "unmarked upgrade", single: true, yielded: true, marked: false, frozen: true },
    {
      name: "replacement session",
      single: true,
      yielded: true,
      frozen: true,
      current: { sessionId: "new-parent" },
    },
    {
      name: "reset lifecycle",
      single: true,
      yielded: true,
      frozen: true,
      current: { sessionId: "sess-main", lifecycleRevision: "rev-2" },
    },
  ])("preserves the admitted reply policy: $name", async (scenario) => {
    const { single, yielded, current, marked = true } = scenario;
    if (current) {
      setSessionStore({ [REQUESTER]: current });
    }
    const children = settledPrivateChildren(scenario);
    if (scenario.frozen) {
      children[0]!.requesterSettleWake!.batchRunIds = ["run-b"];
    }
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(!current);
    if (current) {
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
      return;
    }
    expect(deliverSpy).toHaveBeenCalledOnce();
    const call = deliveredCallArg();
    expect(call.completionRequesterSessionId).toBe("sess-main");
    expect(call.requireVisibleReply).toBeUndefined();
    expect(call.completionTarget).toBe(yielded && marked ? undefined : "parent");
    if (yielded && single) {
      expect(call.directIdempotencyKey).toBe(requesterSettleKey("run-b:yield-1"));
    }
    const trigger = String(call.triggerMessage);
    expect(trigger).toContain("private marker");
    if (yielded && marked) {
      expect(trigger).not.toContain("Your final reply stays internal");
      expect(trigger).toContain("under its normal reply rules");
      expect(trigger).toContain("must go through the message tool, send your answer with it");
      expect(trigger).toContain("avoid repeating an update already delivered");
    } else if (!yielded) {
      expect(trigger).not.toContain("messaging tool");
      expect(trigger).toContain("Your final reply is recorded in this session for the requester");
      expect(trigger).toContain("briefly record the reviewed outcome and any remaining work");
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      expect(deliverSpy).toHaveBeenCalledOnce();
      expect(completeBatchSpy.mock.calls[0]?.[2]).not.toHaveProperty(
        "requesterVisibleFinalDelivered",
      );
    }
  });

  it.each(privateRequesterRouteCases())(
    "guides private $name settles according to the requester route",
    async ({ origin, canDeliver }) => {
      settledPrivateChildren({});
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ requesterOrigin: origin })),
      ).toBe(true);
      const trigger = String(deliveredCallArg().triggerMessage);
      if (canDeliver) {
        expect(trigger).toContain("send it through an available, permitted messaging tool");
      } else {
        expect(trigger).not.toContain("messaging tool");
        expect(trigger).toContain("Your final reply is recorded in this session for the requester");
        expect(trigger).toContain("no messaging send is needed");
      }
    },
  );
});
