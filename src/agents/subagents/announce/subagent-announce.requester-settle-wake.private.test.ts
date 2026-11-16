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
    expect(await wake()).toBe(!current);
    if (current) {
      expect(deliverSpy).not.toHaveBeenCalled();
      expect(recordGatewaySessionRunFailure).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({
            sessionKey: REQUESTER,
            sessionId: current.sessionId,
            expectedLifecycleRevision: current.lifecycleRevision,
          }),
          notice: expect.stringContaining("previous session"),
        }),
      );
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ sessionKey: REQUESTER, sessionId: current.sessionId }),
          ...(current.lifecycleRevision ? { lifecycleRevision: current.lifecycleRevision } : {}),
        }),
      );
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
    expect(recordGatewaySessionRunFailure).not.toHaveBeenCalled();
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

  it("keeps the held results owed when the replacement notice cannot be persisted", async () => {
    const children = settledPrivateChildren({ yielded: true });
    const onUpdate = vi.fn();
    onTestFinished(onInternalSessionTranscriptUpdate(onUpdate));
    setSessionStore({ [REQUESTER]: { sessionId: "new-parent" } });
    vi.mocked(recordGatewaySessionRunFailure).mockImplementationOnce(async () => {
      throw new Error("notice unavailable");
    });
    expect(await wake()).toBe(false);
    expect(completeBatchSpy).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(children.every((child) => child.requesterSettleWake !== undefined)).toBe(true);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(await wake()).toBe(false);
    expect(completeBatchSpy).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});
