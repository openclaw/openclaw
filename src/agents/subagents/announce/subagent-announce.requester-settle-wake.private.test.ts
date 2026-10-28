import { describe, expect, it } from "vitest";
import { visibleCompletion } from "./subagent-announce-fixtures.test-support.js";
import {
  registryRuntimeMock,
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

describe("quiet requester restart continuation", () => {
  it("does not reoffer a confirmed interruption notice in a requester-settle wave", async () => {
    sessionStore[REQUESTER] = { sessionId: "sess-parent" };
    const child = makeSettledChild({
      runId: "delivered-interruption",
      delivery: { status: "delivered", deliveredAt: 4_000 },
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 3_000,
        interruptionReason: "gateway-restart",
        outcome: { status: "error", error: "Gateway restarted" },
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    expect(await wake({ settledEntry: child })).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(child.requesterSettleWake).toBeUndefined();
  });

  it.each([
    "main",
    "nested",
    "reset",
    "cancelled",
    "successful",
    "replaced-child",
    "failed-placement",
  ] as const)(
    "keeps a quiet restart continuation private to its original %s parent",
    async (scenario) => {
      const requesterSessionKey = scenario === "nested" ? "agent:main:subagent:middle" : REQUESTER;
      sessionStore[requesterSessionKey] = {
        sessionId: "sess-parent",
        lifecycleRevision: scenario === "reset" ? "replacement" : "original",
      };
      const child = makeSettledChild({
        runId: "quiet-interrupted",
        requesterSessionKey,
        expectsCompletionMessage: false,
        completionTarget: "parent",
        completionRequesterSessionId: "sess-parent",
        completionRequesterLifecycleRevision: "original",
        suppressCompletionDelivery: scenario === "cancelled",
        delivery: { status: "not_required" },
        ...(scenario === "failed-placement"
          ? { terminalOwner: "interrupted-recovery", endedReason: "subagent-error" }
          : {}),
        execution: {
          status: "terminal",
          startedAt: 2_000,
          endedAt: 3_000,
          interruptionReason:
            scenario === "successful" || scenario === "failed-placement"
              ? undefined
              : "gateway-restart",
          outcome:
            scenario === "successful"
              ? { status: "ok" }
              : scenario === "failed-placement"
                ? { status: "error", error: "Worker setup failed; repair it before resuming." }
                : { status: "error", error: "The original child session was replaced." },
          suppressSessionEffects: scenario === "replaced-child" ? true : undefined,
        },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
      const shouldContinue =
        scenario === "main" ||
        scenario === "nested" ||
        scenario === "replaced-child" ||
        scenario === "failed-placement";
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(
          wakeParams({ requesterSessionKey, settledEntry: child }),
        ),
      ).toBe(shouldContinue);
      expect(deliverSpy).toHaveBeenCalledTimes(shouldContinue ? 1 : 0);
      if (shouldContinue) {
        const delivery = deliveredCallArg();
        expect(delivery).toMatchObject({
          completionTarget: "parent",
          completionRequesterSessionId: "sess-parent",
          completionRequesterLifecycleRevision: "original",
          expectsCompletionMessage: false,
        });
        if (scenario === "failed-placement") {
          expect(delivery.triggerMessage).toContain("Every subagent in this batch has now settled");
          expect(delivery.triggerMessage).toContain(
            "status: error: Worker setup failed; repair it before resuming.",
          );
        } else {
          expect(delivery.triggerMessage).toContain("Reconcile every listed unfinished child");
          expect(delivery.triggerMessage).toContain(child.childSessionKey);
          expect(delivery.triggerMessage).toContain("The original child session was replaced.");
        }
        expect(delivery.triggerMessage).toContain("Process this result privately");
      }
      expect(child.requesterSettleWake).toBeUndefined();
    },
  );
});
