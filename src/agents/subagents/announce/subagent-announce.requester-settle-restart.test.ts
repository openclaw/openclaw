import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  sessionStore,
  registryRuntimeMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  REQUESTER,
  deliverSpy,
  makeSettledChild,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("quiet requester restart continuation", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({ session: { mainKey: "main", scope: "per-sender" } });
  });

  afterEach(() => clearRuntimeConfigSnapshot());

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

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child })),
    ).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(child.requesterSettleWake).toBeUndefined();
  });

  it.each(["main", "nested", "reset", "cancelled", "successful", "replaced-child"] as const)(
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
        execution: {
          status: "terminal",
          startedAt: 2_000,
          endedAt: 3_000,
          interruptionReason: scenario === "successful" ? undefined : "gateway-restart",
          outcome:
            scenario === "successful"
              ? { status: "ok" }
              : { status: "error", error: "The original child session was replaced." },
          suppressSessionEffects: scenario === "replaced-child" ? true : undefined,
        },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
      const shouldContinue =
        scenario === "main" || scenario === "nested" || scenario === "replaced-child";
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
        expect(delivery.triggerMessage).toContain("Reconcile every listed unfinished child");
        expect(delivery.triggerMessage).toContain(child.childSessionKey);
        expect(delivery.triggerMessage).toContain("Process this result privately");
        expect(delivery.triggerMessage).toContain("The original child session was replaced.");
      }
      expect(child.requesterSettleWake).toBeUndefined();
    },
  );
});
