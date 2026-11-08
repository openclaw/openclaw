import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  sessionStore,
  registryRuntimeMock,
  readDescendantFacts,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  REQUESTER,
  deliverSpy,
  makeSettledChild,
  deliveredCallArg,
  completeBatchSpy,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("quiet requester restart continuation", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({ session: { mainKey: "main", scope: "per-sender" } });
  });

  afterEach(() => clearRuntimeConfigSnapshot());

  it.each([
    "fulfilled",
    "undelivered",
    "frozen",
    "current-child",
    "same-task",
    "attempted",
    "source-revoked",
  ] as const)(
    "settles only the fulfilled original wake after child reuse (%s)",
    async (scenario) => {
      const child = makeSettledChild({
        runId: "saved-original",
        requesterAgentId: "main",
        completionRequesterSessionId: "sess-main",
        generation: 1,
        cleanupCompletedAt: 3_000,
        completion: { required: true, capturedAt: 3_000, resultText: "SAVED ORIGINAL RESULT" },
        delivery: { status: scenario === "undelivered" ? "pending" : "delivered" },
        execution: {
          status: "terminal",
          startedAt: 2_000,
          endedAt: 3_000,
          outcome: { status: "error", error: "saved interruption" },
          interruptionReason: "gateway-restart",
          suppressSessionEffects: true,
        },
        requesterSettleWake: {
          status: "pending",
          attemptCount: scenario === "attempted" ? 1 : 0,
          ...(scenario === "frozen"
            ? { batchRunIds: ["saved-original"], rearmGeneration: 1, requesterYieldBatch: true }
            : {}),
        },
      });
      const successor = makeSettledChild({
        runId: "new-task",
        requesterAgentId: "main",
        generation: 2,
        taskRunId: scenario === "same-task" ? child.runId : undefined,
        childSessionKey: child.childSessionKey,
        expectsCompletionMessage: false,
        requesterSettleWake: undefined,
      });
      const originalSuccessor = structuredClone(successor);
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(
        scenario === "current-child" ? [child] : [child, successor],
      );
      registryRuntimeMock.getLatestLiveSubagentRunByChildSessionKey.mockImplementation(
        (sessionKey, matches) =>
          sessionKey === child.childSessionKey
            ? (scenario === "current-child" ? [child] : [successor, child]).find(
                (entry) => !matches || matches(entry),
              )
            : undefined,
      );
      let sourceCurrent = true;
      if (scenario === "source-revoked") {
        readDescendantFacts.mockImplementation(async () => {
          sourceCurrent = false;
          return { unsettled: false, active: 0 };
        });
      }
      const params = wakeParams({ settledEntry: child, isSourceCurrent: () => sourceCurrent });
      const shouldDispatch = scenario === "frozen" || scenario === "current-child";
      expect(await maybeWakeRequesterAfterAllChildrenSettled(params)).toBe(shouldDispatch);
      expect(successor).toEqual(originalSuccessor);
      if (scenario === "fulfilled") {
        expect(child.requesterSettleWake).toBeUndefined();
        expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith([child.runId]);
        expect(deliverSpy).not.toHaveBeenCalled();
        expect(await maybeWakeRequesterAfterAllChildrenSettled(params)).toBe(false);
        expect(completeBatchSpy).toHaveBeenCalledTimes(1);
        expect(deliverSpy).not.toHaveBeenCalled();
      } else if (shouldDispatch) {
        expect(deliverSpy).toHaveBeenCalledTimes(1);
        expect(deliveredCallArg().triggerMessage).toContain("SAVED ORIGINAL RESULT");
        if (scenario === "current-child") {
          expect(deliveredCallArg().triggerMessage).toContain(
            "Reconcile every listed unfinished child",
          );
          expect(deliveredCallArg().triggerMessage).toContain(child.childSessionKey);
        }
        expect(child.requesterSettleWake).toBeUndefined();
      } else {
        expect(child.requesterSettleWake).toBeDefined();
        expect(completeBatchSpy).not.toHaveBeenCalled();
        expect(deliverSpy).not.toHaveBeenCalled();
      }
    },
  );

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
