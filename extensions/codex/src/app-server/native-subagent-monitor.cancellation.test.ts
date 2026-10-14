import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, onTestFinished, vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import type { ParentOwner } from "./native-subagent-monitor-types.js";
import {
  CodexNativeSubagentMonitor,
  childTurnCompletedNotification,
  createClient,
  createCompletionScope,
  createNativeModelSourceFixture,
  createRuntime,
  directSpawnItem,
  nativeHistoryOwner,
  notifyChildStarted,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";

const parentThreadId = "parent-thread";
const sessionKey = "agent:main:native-stop";
// The Gateway supplies selection; this fixture proves the native owner's custody propagation.
const requestCustody: NonNullable<ParentOwner["requestCustody"]> = Object.freeze({});
const requester = {
  parentThreadId,
  agentId: "main",
  sessionKey,
  sessionId: "physical-1",
  lifecycleRevision: "revision-1",
  requesterTurnRunId: "parent-run",
  acceptsRequest: (custody: ParentOwner["requestCustody"]) => custody === requestCustody,
  assertCurrent: () => {},
};
const registration = {
  requestCustody,
  parentThreadId,
  agentId: "main",
  requesterSessionKey: sessionKey,
  requesterTurnRunId: "parent-run",
  historyOwner: nativeHistoryOwner(),
  completionScope: createCompletionScope(sessionKey),
};

async function nativeChild(startChild = true, keepParent = false, attributed = true) {
  const client = createClient();
  const runtime = createRuntime();
  const interrupted = createDeferred<void>();
  const original = client.request.getMockImplementation();
  if (!original) {
    throw new Error("Missing transport fixture");
  }
  client.request.mockImplementation(async (method, params, options) => {
    if (method === "turn/interrupt") {
      expect(params).toEqual({ threadId: "child-thread", turnId: "child-turn" });
      interrupted.resolve();
      return {};
    }
    return original(method, params, options);
  });
  const interruptBudgets: number[] = [];
  const releaseChild = vi.fn();
  const claimDirectChild = vi.fn(() => releaseChild);
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    recoveryPollDelaysMs: [],
    interruptChildAndWait: (threadId, turnId, assertCurrent, timeoutMs) => {
      interruptBudgets.push(timeoutMs);
      return interruptCodexTurnAndWaitBestEffort(client.client, {
        threadId,
        turnId,
        assertCurrent,
        timeoutMs,
      });
    },
  });
  onTestFinished(() => monitor.dispose());
  const parent = await monitor.registerParent({
    ...registration,
    requesterTurnRunId: attributed ? registration.requesterTurnRunId : undefined,
    requestCustody: attributed ? requestCustody : undefined,
    modelSource: createNativeModelSourceFixture(["test-model"]),
    claimDirectChild,
  });
  parent.bindTurn("parent-turn");
  await notifyChildStarted(client);
  await client.notify({
    method: "item/completed",
    params: {
      threadId: parentThreadId,
      turnId: "parent-turn",
      item: directSpawnItem("v1", parentThreadId, "child-thread"),
    },
  });
  if (startChild) {
    await client.notify(turnStartedNotification("child-turn"));
  }
  await client.notify(
    childTurnCompletedNotification({
      threadId: parentThreadId,
      turnId: "parent-turn",
      status: "completed",
    }),
  );
  if (!keepParent) {
    await parent.unregister();
  }
  return {
    client,
    runtime,
    monitor,
    releaseChild,
    claimDirectChild,
    interruptBudgets,
    interrupted: interrupted.promise,
  };
}

it.each(["interrupted", "preturn", "natural success"] as const)(
  "settles accepted Stop through the actual %s native completion owner",
  async (ending) => {
    const f = await nativeChild(ending !== "preturn");
    const historyEntered = createDeferred<void>();
    const releaseHistory = createDeferred<void>();
    f.client.setThreadReadFactory("child-thread", async () => {
      historyEntered.resolve();
      await releaseHistory.promise;
      return threadRead({ turnId: "child-turn", result: "The child finished naturally" });
    });
    let monotonicNow = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    onTestFinished(() => clock.mockRestore());
    let returned = false;
    const accepted = createDeferred<void>();
    const stop = f.monitor
      .withDescendantCancellation(requester, (cancel) => {
        const result = cancel();
        accepted.resolve();
        return result;
      })
      .then((result) => {
        returned = true;
        return result;
      });
    try {
      await awaitGateBeforeSettlement(accepted.promise, stop, "Stop was not accepted");
      if (ending === "preturn") {
        expect(f.interruptBudgets).toEqual([]);
        monotonicNow += 1_000;
        await f.client.notify(turnStartedNotification("child-turn"));
      }
      await awaitGateBeforeSettlement(f.interrupted, stop, "Stop skipped native interruption");
      expect(f.interruptBudgets).toEqual([ending === "preturn" ? 4_000 : 5_000]);
      expect(returned).toBe(false);
      expect(f.releaseChild).not.toHaveBeenCalled();
      const completion = f.client.notify(
        childTurnCompletedNotification({
          status: ending === "natural success" ? "completed" : "interrupted",
        }),
      );
      if (ending === "natural success") {
        await awaitGateBeforeSettlement(historyEntered.promise, stop, "Stop skipped real history");
        expect(returned).toBe(false);
        // The interrupt budget does not bound post-terminal history/delivery work.
        monotonicNow += 6_000;
        releaseHistory.resolve();
      }
      await completion;
      expect(await stop).toEqual(
        ending === "natural success"
          ? { killed: 0, cancelledRequesters: [] }
          : {
              killed: 1,
              cancelledRequesters: [
                {
                  agentId: "main",
                  sessionKey,
                  sessionId: "physical-1",
                  lifecycleRevision: "revision-1",
                  requesterTurnRunId: "parent-run",
                },
              ],
            },
      );
      expect(f.releaseChild).toHaveBeenCalledOnce();
      if (ending === "natural success") {
        expect(f.runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
          expect.objectContaining({ result: expect.stringContaining("finished naturally") }),
        );
      } else {
        expect(f.runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      }
    } finally {
      releaseHistory.resolve();
      f.client.close();
      await stop.catch(() => {});
    }
  },
);

it("joins selected pending custody while admitting a different request during session Stop", async () => {
  const client = createClient();
  const runtime = createRuntime();
  const capture = createDeferred<undefined>();
  runtime.captureAgentHarnessCompletionCustody.mockImplementation(() => capture.promise);
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    recoveryPollDelaysMs: [],
  });
  onTestFinished(() => monitor.dispose());
  const pending = monitor.registerParent(registration);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  let settled = false;
  const entered = createDeferred<void>();
  const stop = monitor
    .withDescendantCancellation({ ...requester, requesterTurnRunId: undefined }, (cancel) => {
      const result = cancel();
      entered.resolve();
      return result;
    })
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await awaitGateBeforeSettlement(entered.promise, stop, "Pending owner was not reserved");
    expect(settled).toBe(false);
    await expect(monitor.registerParent(registration)).rejects.toThrow("still settling");
    const sibling = monitor.registerParent({
      ...registration,
      requesterTurnRunId: "sibling-request",
      requestCustody: Object.freeze({}),
    });
    const siblingAccepted = expect(sibling).resolves.toBeDefined();
    capture.resolve(undefined);
    await rejected;
    await siblingAccepted;
    expect(await stop).toEqual({ killed: 0, cancelledRequesters: [] });
  } finally {
    capture.resolve(undefined);
    await pending.catch(() => {});
    await stop.catch(() => {});
  }
});

it("keeps a sibling request and refuses a stale physical generation before Stop acceptance", async () => {
  const f = await nativeChild();
  const consume = vi.fn((cancel: () => Promise<unknown>) => cancel());
  await expect(
    f.monitor.withDescendantCancellation({ ...requester, lifecycleRevision: "replaced" }, consume),
  ).rejects.toThrow("generation changed");
  expect(consume).not.toHaveBeenCalled();
  expect(
    await f.monitor.withDescendantCancellation(
      { ...requester, requesterTurnRunId: "different-request", acceptsRequest: () => false },
      (cancel) => cancel(),
    ),
  ).toEqual({ killed: 0, cancelledRequesters: [] });
  expect(f.interruptBudgets).toEqual([]);
  expect(f.releaseChild).not.toHaveBeenCalled();
});

it("leaves an unselected detached child running during session-wide Stop", async () => {
  const f = await nativeChild();
  const completion = f.interrupted.then(() =>
    f.client.notify(childTurnCompletedNotification({ status: "interrupted" })),
  );
  try {
    expect(
      await f.monitor.withDescendantCancellation(
        { ...requester, requesterTurnRunId: undefined, acceptsRequest: () => false },
        (cancel) => cancel(),
      ),
    ).toEqual({ killed: 0, cancelledRequesters: [] });
    expect(f.interruptBudgets).toEqual([]);
    expect(f.releaseChild).not.toHaveBeenCalled();
  } finally {
    f.client.close();
    if (f.interruptBudgets.length) {
      await completion;
    }
  }
});

it("fences selected late admissions while preserving another request during session Stop", async () => {
  const f = await nativeChild(true, true);
  const stop = f.monitor.withDescendantCancellation(
    { ...requester, requesterTurnRunId: undefined },
    (cancel) => cancel(),
  );
  try {
    await awaitGateBeforeSettlement(f.interrupted, stop, "Stop skipped the selected child");
    const siblingRelease = vi.fn();
    const siblingClaim = vi.fn(() => siblingRelease);
    const sibling = await f.monitor.registerParent({
      ...registration,
      requesterTurnRunId: "sibling-run",
      requestCustody: Object.freeze({}),
      modelSource: createNativeModelSourceFixture(["test-model"]),
      claimDirectChild: siblingClaim,
    });
    sibling.bindTurn("sibling-turn");
    await notifyChildStarted(f.client, parentThreadId, "sibling-child");
    await f.client.notify({
      method: "item/completed",
      params: {
        threadId: parentThreadId,
        turnId: "sibling-turn",
        item: directSpawnItem("v1", parentThreadId, "sibling-child"),
      },
    });
    expect(siblingClaim).toHaveBeenCalledExactlyOnceWith("sibling-child");
    expect(siblingRelease).not.toHaveBeenCalled();
    await notifyChildStarted(f.client, parentThreadId, "late-child");
    await f.client.notify({
      method: "item/completed",
      params: {
        threadId: parentThreadId,
        turnId: "parent-turn",
        item: directSpawnItem("v1", parentThreadId, "late-child"),
      },
    });
    expect(f.claimDirectChild).toHaveBeenCalledExactlyOnceWith("child-thread");
    expect(f.releaseChild).not.toHaveBeenCalled();
    await f.client.notify(childTurnCompletedNotification({ status: "interrupted" }));
    expect(await stop).toEqual({
      killed: 1,
      cancelledRequesters: [
        {
          agentId: requester.agentId,
          sessionKey,
          sessionId: requester.sessionId,
          lifecycleRevision: requester.lifecycleRevision,
          requesterTurnRunId: requester.requesterTurnRunId,
        },
      ],
      errors: [new Error("Codex descendant admission remains unsettled after cancellation")],
    });
    expect(siblingRelease).not.toHaveBeenCalled();
    expect(f.releaseChild).toHaveBeenCalledOnce();
  } finally {
    f.client.close();
    await stop.catch(() => {});
  }
});

it("does not authorize an ownerless child from its saved session or run identity", async () => {
  const f = await nativeChild(true, false, false);
  expect(await f.monitor.withDescendantCancellation(requester, (cancel) => cancel())).toEqual({
    killed: 0,
    cancelledRequesters: [],
  });
  expect(f.interruptBudgets).toEqual([]);
  expect(f.releaseChild).not.toHaveBeenCalled();
  expect(
    await f.monitor.withDescendantCancellation(
      { ...requester, requesterTurnRunId: undefined },
      (cancel) => cancel(),
    ),
  ).toEqual({ killed: 0, cancelledRequesters: [] });
  expect(f.interruptBudgets).toEqual([]);
  expect(f.releaseChild).not.toHaveBeenCalled();
});
