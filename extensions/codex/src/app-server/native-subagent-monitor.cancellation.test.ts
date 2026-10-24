import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, onTestFinished, vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { NativeDescendantCancellation, ParentOwner } from "./native-subagent-monitor-types.js";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createMonitorFixture,
  createCompletionScope,
  createNativeModelSourceFixture,
  createRuntime,
  directSpawnItem,
  nativeHistoryOwner,
  notifyChildStarted,
  threadRead,
} from "./native-subagent-monitor.test-support.js";

const parentThreadId = "parent-thread";
const sessionKey = "agent:main:native-stop";
// The Gateway supplies selection; this fixture proves the native owner's custody propagation.
const requestCustody: NonNullable<ParentOwner["requestCustody"]> = Object.freeze({});
const cancelledRequester = {
  agentId: "main",
  sessionKey,
  sessionId: "physical-1",
  lifecycleRevision: "revision-1",
  requesterTurnRunId: "parent-run",
};
const requester = {
  ...cancelledRequester,
  parentThreadId,
  acceptsRequest: (custody: ParentOwner["requestCustody"]) => custody === requestCustody,
  assertCurrent: () => {},
};
const noCancellation = { killed: 0, cancelledRequesters: [] };
const cancelled = { killed: 1, cancelledRequesters: [cancelledRequester] };
const registration = {
  requestCustody,
  parentThreadId,
  agentId: "main",
  requesterSessionKey: sessionKey,
  requesterTurnRunId: "parent-run",
  historyOwner: nativeHistoryOwner(),
  completionScope: createCompletionScope(sessionKey),
};

async function spawnChild(
  client: ReturnType<typeof createClient>,
  childThreadId = "child-thread",
  turnId = "parent-turn",
) {
  await client.item(directSpawnItem("v1", parentThreadId, childThreadId), turnId);
}

type Monitor = ReturnType<typeof createMonitorFixture>["monitor"];
function cancelDescendants(
  monitor: Monitor,
  overrides: Partial<NativeDescendantCancellation> = {},
) {
  return monitor.withDescendantCancellation({ ...requester, ...overrides }, (cancel) => cancel());
}
function startStop(monitor: Monitor, overrides: Partial<NativeDescendantCancellation> = {}) {
  const state = { accepted: createDeferred<void>(), returned: false };
  const stop = monitor
    .withDescendantCancellation({ ...requester, ...overrides }, (cancel) => {
      const result = cancel();
      state.accepted.resolve();
      return result;
    })
    .then((result) => {
      state.returned = true;
      return result;
    });
  return { stop, state };
}
function expectUntouched(f: Awaited<ReturnType<typeof nativeChild>>) {
  expect(f.interruptBudgets).toEqual([]);
  expect(f.releaseChild).not.toHaveBeenCalled();
}

async function nativeChild(startChild = true, keepParent = false, attributed = true) {
  const client = createClient();
  ensureCodexAppServerClientRuntime(client.client, {
    agentDir: "/synthetic/native-stop-agent",
    authMode: "prepared-api-key",
  });
  const parentOwnership = await claimCodexAppServerLiveThread(client.client, parentThreadId);
  if (!parentOwnership) {
    throw new Error("Missing parent subscription owner");
  }
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
    retainParentThread: (threadId) => protectCodexAppServerLiveThread(client.client, threadId),
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
  await spawnChild(client);
  if (startChild) {
    await client.startTurn("child-turn");
  }
  await client.completeTurn({
    threadId: parentThreadId,
    turnId: "parent-turn",
    status: "completed",
  });
  if (!keepParent) {
    await parent.unregister();
    await parentOwnership.release(parentThreadId);
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

it.each([true, false])(
  "retires only selected interrupted children (selected=%s)",
  async (selected) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const f = await nativeChild();
    expect(isCodexAppServerLiveThreadClaimed(f.client.client, parentThreadId)).toBe(true);
    await f.client.completeTurn({ status: "interrupted" });
    const stop = cancelDescendants(f.monitor, {
      requesterTurnRunId: undefined,
      acceptsRequest: (custody) => selected && custody === requestCustody,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await stop).toEqual(selected ? cancelled : noCancellation);
    expect(f.interruptBudgets).toEqual([]);
    expect(isCodexAppServerLiveThreadClaimed(f.client.client, parentThreadId)).toBe(false);
    expect(f.runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  },
);

it.each(["interrupted", "preturn", "natural success"] as const)(
  "settles accepted Stop through %s native completion",
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
    const { stop, state } = startStop(f.monitor);
    try {
      await awaitGateBeforeSettlement(state.accepted.promise, stop, "Stop was not accepted");
      if (ending === "preturn") {
        expect(f.interruptBudgets).toEqual([]);
        monotonicNow += 1_000;
        await f.client.startTurn("child-turn");
      }
      await awaitGateBeforeSettlement(f.interrupted, stop, "Stop skipped native interruption");
      expect(f.interruptBudgets).toEqual([ending === "preturn" ? 4_000 : 5_000]);
      expect(state.returned).toBe(false);
      expect(f.releaseChild).not.toHaveBeenCalled();
      const completion = f.client.completeTurn({
        status: ending === "natural success" ? "completed" : "interrupted",
      });
      if (ending === "natural success") {
        await awaitGateBeforeSettlement(historyEntered.promise, stop, "Stop skipped real history");
        expect(state.returned).toBe(false);
        // The interrupt budget does not bound post-terminal history/delivery work.
        monotonicNow += 6_000;
        releaseHistory.resolve();
      }
      await completion;
      expect(await stop).toEqual(ending === "natural success" ? noCancellation : cancelled);
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

it("joins selected custody while admitting another request during Stop", async () => {
  const { runtime, monitor } = createMonitorFixture();
  const capture = createDeferred<undefined>();
  runtime.captureAgentHarnessCompletionCustody.mockImplementation(() => capture.promise);
  onTestFinished(() => monitor.dispose());
  const pending = monitor.registerParent(registration);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  const { stop, state } = startStop(monitor, { requesterTurnRunId: undefined });
  try {
    await awaitGateBeforeSettlement(state.accepted.promise, stop, "Pending owner was not reserved");
    expect(state.returned).toBe(false);
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
    expect(await stop).toEqual(noCancellation);
  } finally {
    capture.resolve(undefined);
    await pending.catch(() => {});
    await stop.catch(() => {});
  }
});

it.each([
  ["sibling request", true, "different-request"],
  ["unselected detached child", true, undefined],
  ["ownerless child by run or session", false, "parent-run"],
] as const)("does not authorize %s during Stop", async (_, attributed, requesterTurnRunId) => {
  const f = await nativeChild(true, false, attributed);
  if (attributed && requesterTurnRunId) {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    const consume = vi.fn((cancel: () => Promise<unknown>) => cancel());
    await expect(
      f.monitor.withDescendantCancellation(
        { ...requester, lifecycleRevision: "replaced" },
        consume,
      ),
    ).rejects.toThrow("generation changed");
    expect(consume).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Codex descendant cancellation requester generation mismatch",
      {
        agentMatches: true,
        sessionKeyMatches: true,
        sessionIdMatches: true,
        lifecycleMatches: false,
        registeredHistoryPresent: true,
        registeredLifecyclePresent: true,
        requestedLifecyclePresent: true,
        preparing: false,
        activeOwnerCount: 0,
        pendingOwnerCount: 0,
      },
    );
  }
  const completion = f.interrupted.then(() => f.client.completeTurn({ status: "interrupted" }));
  try {
    expect(
      await cancelDescendants(f.monitor, {
        requesterTurnRunId,
        acceptsRequest: attributed ? () => false : requester.acceptsRequest,
      }),
    ).toEqual(noCancellation);
    expectUntouched(f);
    if (!attributed) {
      expect(await cancelDescendants(f.monitor, { requesterTurnRunId: undefined })).toEqual(
        noCancellation,
      );
      expectUntouched(f);
    }
  } finally {
    f.client.close();
    if (f.interruptBudgets.length) {
      await completion;
    }
  }
});

it("cancels the current generation after a retained Codex parent thread is reused", async () => {
  const f = await nativeChild();
  const currentRequestCustody: NonNullable<ParentOwner["requestCustody"]> = Object.freeze({});
  const currentReleaseChild = vi.fn();
  const currentInterrupted = createDeferred<void>();
  const request = f.client.request.getMockImplementation();
  if (!request) {
    throw new Error("Missing transport fixture");
  }
  f.client.request.mockImplementation((method, params, options) => {
    if (
      method === "turn/interrupt" &&
      (params as { threadId?: string }).threadId === "current-child"
    ) {
      expect(params).toEqual({ threadId: "current-child", turnId: "current-child-turn" });
      currentInterrupted.resolve();
      return Promise.resolve({});
    }
    return request(method, params, options);
  });
  const currentParent = await f.monitor.registerParent({
    ...registration,
    requestCustody: currentRequestCustody,
    requesterTurnRunId: "current-parent-run",
    historyOwner: { ...nativeHistoryOwner(), lifecycleRevision: "revision-2" },
    modelSource: createNativeModelSourceFixture(["test-model"]),
    claimDirectChild: () => currentReleaseChild,
  });
  currentParent.bindTurn("current-parent-turn");
  await notifyChildStarted(f.client, parentThreadId, "current-child");
  await spawnChild(f.client, "current-child", "current-parent-turn");
  await f.client.startTurn("current-child-turn", { threadId: "current-child" });
  await currentParent.unregister();

  const stop = cancelDescendants(f.monitor, {
    lifecycleRevision: "revision-2",
    requesterTurnRunId: "current-parent-run",
    acceptsRequest: (custody) => custody === currentRequestCustody,
  });
  try {
    await awaitGateBeforeSettlement(
      currentInterrupted.promise,
      stop,
      "Stop skipped the current generation child",
    );
    await f.client.completeTurn({
      threadId: "current-child",
      turnId: "current-child-turn",
      status: "interrupted",
    });
    expect(await stop).toEqual({
      killed: 1,
      cancelledRequesters: [
        {
          agentId: "main",
          sessionKey,
          sessionId: "physical-1",
          lifecycleRevision: "revision-2",
          requesterTurnRunId: "current-parent-run",
        },
      ],
    });
    expect(currentReleaseChild).toHaveBeenCalledOnce();
    expect(f.releaseChild).not.toHaveBeenCalled();
  } finally {
    f.client.close();
    await currentParent.unregister();
    await stop.catch(() => {});
  }
});

it("fences late admissions while preserving another request during Stop", async () => {
  const f = await nativeChild(true, true);
  const stop = cancelDescendants(f.monitor, { requesterTurnRunId: undefined });
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
    await spawnChild(f.client, "sibling-child", "sibling-turn");
    expect(siblingClaim).toHaveBeenCalledExactlyOnceWith("sibling-child");
    expect(siblingRelease).not.toHaveBeenCalled();
    await notifyChildStarted(f.client, parentThreadId, "late-child");
    await spawnChild(f.client, "late-child", "parent-turn");
    expect(f.claimDirectChild).toHaveBeenCalledExactlyOnceWith("child-thread");
    expect(f.releaseChild).not.toHaveBeenCalled();
    await f.client.completeTurn({ status: "interrupted" });
    expect(await stop).toEqual({
      ...cancelled,
      errors: [new Error("Codex descendant admission remains unsettled after cancellation")],
    });
    expect(siblingRelease).not.toHaveBeenCalled();
    expect(f.releaseChild).toHaveBeenCalledOnce();
  } finally {
    f.client.close();
    await stop.catch(() => {});
  }
});
