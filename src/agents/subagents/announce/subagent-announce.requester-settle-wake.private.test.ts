import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { recordGatewaySessionRunFailure } from "../../../sessions/session-run-error.js";
import { onInternalSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
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

// mock-isolation: Policy fixtures use an in-memory session map; the benchmark proves real notice storage.
vi.mock("../../../sessions/session-run-error.js", () => ({
  recordGatewaySessionRunFailure: vi.fn(async () => {}),
}));

beforeEach(() => vi.mocked(recordGatewaySessionRunFailure).mockReset());

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
    const onUpdate = vi.fn();
    onTestFinished(onInternalSessionTranscriptUpdate(onUpdate));
    if (current) {
      setSessionStore({ [REQUESTER]: current });
    }
    const children = settledPrivateChildren(scenario);
    if (scenario.frozen) {
      children[0]!.requesterSettleWake!.batchRunIds = ["run-b"];
    }
    // The chat key is the address: a reset or a replacement session still receives the results.
    expect(await wake()).toBe(true);
    const call = deliveredCallArg();
    expect(recordGatewaySessionRunFailure).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
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
