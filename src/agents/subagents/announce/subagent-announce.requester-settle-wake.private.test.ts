import { describe, expect, it } from "vitest";
import { visibleCompletion } from "./subagent-announce-fixtures.test-support.js";
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
const wake = (overrides?: Parameters<typeof wakeParams>[0]) =>
  maybeWakeRequesterAfterAllChildrenSettled(wakeParams(overrides));

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
  it.each`
    name                     | mixed    | single   | yielded  | marked   | frozen   | current
    ${"pending mixed pair"}  | ${true}  | ${false} | ${false} | ${true}  | ${false} | ${undefined}
    ${"yielded mixed pair"}  | ${true}  | ${false} | ${true}  | ${true}  | ${false} | ${undefined}
    ${"unmarked upgrade"}    | ${false} | ${true}  | ${true}  | ${false} | ${true}  | ${undefined}
    ${"replacement session"} | ${false} | ${true}  | ${true}  | ${true}  | ${true}  | ${{ sessionId: "new-parent" }}
    ${"reset lifecycle"}     | ${false} | ${true}  | ${true}  | ${true}  | ${true}  | ${{ sessionId: "sess-main", lifecycleRevision: "rev-2" }}
  `("preserves the admitted reply policy: $name", async (scenario: Scenario) => {
    const { single, yielded, current, marked = true } = scenario;
    if (current) {
      setSessionStore({ [REQUESTER]: current });
    }
    const children = settledPrivateChildren(scenario);
    if (scenario.frozen) {
      children[0]!.requesterSettleWake!.batchRunIds = ["run-b"];
    }
    expect(await wake()).toBe(!current);
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
      expect(trigger).toContain("must go through the message tool, send your answer with it");
    } else if (!yielded) {
      expect(trigger).not.toContain("messaging tool");
      expect(trigger).toContain("Your final reply is recorded in this session for the requester");
      expect(await wake()).toBe(false);
      expect(deliverSpy).toHaveBeenCalledOnce();
      expect(completeBatchSpy.mock.calls[0]?.[2]).not.toHaveProperty(
        "requesterVisibleFinalDelivered",
      );
    }
  });

  it("forwards the requester route to private completion guidance", async () => {
    settledPrivateChildren({});
    expect(await wake({ requesterOrigin: { channel: "discord", to: "channel:123" } })).toBe(true);
    expect(deliveredCallArg().triggerMessage).toContain(
      "send it through an available, permitted messaging tool",
    );
  });
});

describe("requester settle wake attempt cap", () => {
  it("does not dispatch again when a restored wake already spent every attempt", async () => {
    // A wake restored from disk reads back as "dispatching". Its attempt counter is
    // frozen at the cap, so the cap guard (which only matched a pending wake) never
    // fired and the wake re-armed on every sweep, forever.
    const children = [
      makeSettledChild({
        runId: "run-b",
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 3,
          batchRunIds: ["run-b"],
          rearmGeneration: 1,
        },
      }),
    ];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    const woken = await wake();

    expect(woken).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenCalledWith(
      ["run-b"],
      expect.anything(),
      expect.objectContaining({ delivered: false, path: "none" }),
    );
  });

  it("counts a restored dispatching wake toward the cap instead of freezing it", async () => {
    const children = [
      makeSettledChild({
        runId: "run-b",
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          batchRunIds: ["run-b"],
          rearmGeneration: 1,
        },
      }),
    ];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    deliverSpy.mockResolvedValue({ delivered: false, path: "none", disposition: "retryable" });

    await wake();

    // The attempt counter must advance past the frozen value, otherwise it can never
    // reach the cap and the wake retries without bound.
    expect(deliverSpy).toHaveBeenCalledOnce();
    const [, , outcome] = completeBatchSpy.mock.calls[0] ?? [];
    expect(outcome).toMatchObject({ delivered: false });
  });
});
