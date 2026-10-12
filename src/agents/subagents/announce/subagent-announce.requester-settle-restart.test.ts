import { describe, expect, it } from "vitest";
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
  it.each(["main", "nested", "reset", "cancelled", "successful"] as const)(
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
          outcome: scenario === "successful" ? { status: "ok" } : { status: "error" },
        },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
      const shouldContinue = scenario === "main" || scenario === "nested";
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
      }
      expect(child.requesterSettleWake).toBeUndefined();
    },
  );
});
