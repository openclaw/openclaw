import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexNativeHookRelay } from "./native-hook-relay.js";
import {
  createClient,
  createRuntime,
  turnStartedNotification,
  directSpawnItem,
  itemNotification,
  collabItem,
  agentMessage,
  CodexNativeSubagentMonitor,
  createMonitorFixture as monitorFixture,
  createCompletionScope,
  notifyChildStarted,
  childTurnCompletedNotification,
  threadRead,
  createNativeModelSourceFixture as modelSource,
  requireNativeModelSourceCapture as requireCapture,
} from "./native-subagent-monitor.test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";

type Monitor = InstanceType<typeof CodexNativeSubagentMonitor>;
type ParentOptions = Omit<Parameters<Monitor["registerParent"]>[0], "parentThreadId">;

function registerDirect(monitor: Monitor, options: ParentOptions) {
  return monitor.registerParent({ parentThreadId: "parent-thread", ...options });
}

async function directFixture(options: ParentOptions = {}) {
  const f = monitorFixture();
  const release = vi.fn();
  const claimDirectChild = vi.fn(() => release);
  const owner = await registerDirect(f.monitor, { claimDirectChild, ...options });
  return { ...f, owner, release, claimDirectChild };
}
const testModel = (model: string) => ({ provider: "test-provider", model });
const mainRequester = {
  requesterSessionKey: "agent:main:main",
  completionScope: createCompletionScope("agent:main:main"),
};

describe("CodexNativeSubagentMonitor", () => {
  it.each(["completed", "interrupted"] as const)(
    "protects resumed inference before turn/started until it is %s",
    async (status) => {
      const client = createClient();
      ensureCodexAppServerClientRuntime(client.client, {
        agentDir: "/tmp/codex-resumed-inference-retention",
      });
      const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime(), {
        retainParentThread: (threadId) => protectCodexAppServerLiveThread(client.client, threadId),
      });
      onTestFinished(async () => {
        await monitor.retireParent("parent-thread");
        await monitor.dispose();
        client.close();
      });
      const releaseForResume = () =>
        releaseCodexBoundLiveThread({
          client: client.client,
          threadId: "parent-thread",
          lifecycleTiming: createCodexThreadLifecycleTimingTracker(false),
        });
      await retainCodexAppServerLiveThread(client.client, "parent-thread");
      const first = await monitor.registerParent({
        parentThreadId: "parent-thread",
        modelSource: modelSource(["model-a"]),
      });
      first.bindTurn("parent-a");
      await notifyChildStarted(client);
      await client.notify(
        itemNotification(directSpawnItem("v2", "parent-thread", "child-thread"), "parent-a"),
      );
      await client.notify(turnStartedNotification("child-a"));
      await client.notify(
        childTurnCompletedNotification({ turnId: "child-a", status: "interrupted" }),
      );
      await first.unregister();
      await expect(releaseForResume()).resolves.toBe(true);

      await retainCodexAppServerLiveThread(client.client, "parent-thread");
      const second = await monitor.registerParent({
        parentThreadId: "parent-thread",
        modelSource: modelSource(["model-b"]),
      });
      second.bindTurn("parent-b");
      await client.notify(interactionNotification("accepted-resume", "parent-b"));
      const resumed = requireCapture(
        await monitor.captureModelSource({
          threadId: "child-thread",
          turnId: "child-b",
          parentThreadId: "parent-thread",
          parentTurnId: "parent-b",
          rootTurnId: "parent-b",
        }),
      );
      onTestFinished(() => resumed.release());
      await second.unregister();
      await expect(releaseForResume()).rejects.toThrow("claimed by active work; stop it first");
      if (status === "interrupted") {
        resumed.cancel();
        expect(() => resumed.assertCurrent()).toThrow("execution was cancelled");
      }
      await client.notify(
        childTurnCompletedNotification({
          turnId: "child-b",
          status,
          items:
            status === "completed"
              ? [{ id: "resumed-result", type: "agentMessage", text: "Resumed result" }]
              : [],
        }),
      );
      await expect(releaseForResume()).resolves.toBe(true);
    },
  );

  it("keeps A during an accepted B follow-up and gives the new child turn only B's ceiling", async () => {
    const { client, monitor, captureSource } = monitorFixture();
    const a = modelSource(["model-a"]);
    const b = modelSource(["model-b"]);
    const mappingA = {
      nativeModel: testModel("wire-a"),
      authorizedModel: testModel("model-a"),
    };
    const mappingB = {
      nativeModel: testModel("wire-b"),
      authorizedModel: testModel("model-b"),
    };
    const first = await registerDirect(monitor, { modelSource: a });
    first.bindTurn("parent-a", mappingA);
    await notifyChildStarted(client);
    await client.startTurn("child-a");
    const originalRequest = {
      threadId: "child-thread",
      turnId: "child-a",
      parentThreadId: "parent-thread",
      parentTurnId: "parent-a",
      rootTurnId: "parent-a",
    };
    const waitingForReceipt = monitor.captureModelSource(originalRequest);
    await client.notify(spawnNotification("v2", "parent-a"));
    const original = requireCapture(await waitingForReceipt);
    expect(monitor.resolveModelThreadId("child-a")).toBe("child-thread");
    expect(original.modelMapping).toEqual(mappingA);
    await client.item(
      collabItem("sendInput", ["child-thread"], { id: "same-source-steer" }),
      "parent-a",
    );
    await client.sendInputOutput({
      turnId: "parent-a",
      callId: "same-source-steer",
      submissionId: "opaque-steer-receipt",
    });
    await first.unregister();
    expect(
      await monitor.captureModelSource({ ...originalRequest, turnId: "unrelated-turn" }),
    ).toBeUndefined();
    const second = await registerDirect(monitor, { modelSource: b });
    second.bindTurn("parent-b", mappingB);
    await client.notify(interactionNotification("accepted-followup", "parent-b"));
    await second.unregister();
    expect(monitor.resolveModelThreadId("child-b")).toBeUndefined();
    const stillA = await captureSource(originalRequest);
    expect(stillA.modelMapping).toEqual(mappingA);
    expect(stillA.source?.bindModelExecution?.(testModel("model-a"))).toBeDefined();
    expect(() => stillA.source?.bindModelExecution?.(testModel("model-b"))).toThrow(
      "does not admit",
    );
    expect(b.release).not.toHaveBeenCalled();
    stillA.release();
    await client.finishTurn("child-a", agentMessage("a-final", "A finished"));
    expect(a.release).not.toHaveBeenCalled();
    original.release();
    expect(a.release).not.toHaveBeenCalled();
    await client.startTurn("child-b");
    const next = await captureSource({
      ...originalRequest,
      turnId: "child-b",
      parentTurnId: "parent-b",
      rootTurnId: "parent-b",
    });
    expect(next.modelMapping).toEqual(mappingB);
    expect(next.source?.bindModelExecution?.(testModel("model-b"))).toBeDefined();
    expect(() => next.source?.bindModelExecution?.(testModel("model-a"))).toThrow("does not admit");
    await client.finishTurn("child-b", agentMessage("b-final", "B finished"));
    next.release();
    expect(monitor.resolveModelThreadId("child-b")).toBeUndefined();
    expect(b.release).toHaveBeenCalledOnce();
    const disposal = monitor.dispose();
    expect(a.release).toHaveBeenCalledOnce();
    await disposal;
  });

  it("retains nested admitted work and fences only the cancelled execution across regrant", async () => {
    const { client, monitor, captureSource } = monitorFixture();
    const source = modelSource(["model-a", "model-b"]);
    const parent = await registerDirect(monitor, { modelSource: source });
    parent.bindTurn("parent-turn");
    for (const child of ["child-a", "child-b"]) {
      await notifyChildStarted(client, "parent-thread", child);
      await client.item(directSpawnItem("v2", "parent-thread", child));
      await client.notify({
        method: "turn/started",
        params: { threadId: child, turn: { id: `${child}-turn` } },
      });
    }
    const requestA = {
      threadId: "child-a",
      turnId: "child-a-turn",
      parentThreadId: "parent-thread",
      parentTurnId: "parent-turn",
      rootTurnId: "parent-turn",
    };
    const first = await captureSource(requestA);
    expect(monitor.resolveModelThreadId("child-a-turn")).toBe("child-a");
    first.recordNativeReviewRequirement(true);
    first.cancel();
    expect(monitor.resolveModelThreadId("child-a-turn")).toBeUndefined();
    expect(monitor.resolveModelThreadId("child-b-turn")).toBe("child-b");
    expect(() => first.assertCurrent()).toThrow("execution was cancelled");
    await expect(monitor.captureModelSource(requestA)).rejects.toThrow("execution was cancelled");
    const sibling = await captureSource({
      ...requestA,
      threadId: "child-b",
      turnId: "child-b-turn",
    });
    expect(sibling.nativeReviewRequired).toBe(false);
    expect(sibling.source?.bindModelExecution?.(testModel("model-b"))).toBeDefined();
    await notifyChildStarted(client, "child-b", "grandchild", "/root/child-b/grandchild");
    await client.item(directSpawnItem("v2", "child-b", "grandchild"), "child-b-turn", "child-b");
    await client.notify({
      method: "turn/started",
      params: { threadId: "grandchild", turn: { id: "grandchild-turn" } },
    });
    await parent.unregister();
    const nested = await captureSource({
      threadId: "grandchild",
      turnId: "grandchild-turn",
      parentThreadId: "child-b",
      parentTurnId: "child-b-turn",
      rootTurnId: "parent-turn",
    });
    expect(nested.source?.bindModelExecution?.(testModel("model-b"))).toBeDefined();
    first.release();
    sibling.release();
    nested.release();
    const disposal = monitor.dispose();
    expect(monitor.resolveModelThreadId("grandchild-turn")).toBeUndefined();
    expect(source.release).toHaveBeenCalledOnce();
    await disposal;
  });

  it("does not consume pre-bind direct spawn evidence for another turn", async () => {
    const { client, monitor, claimDirectChild, owner } = await directFixture();

    await client.notify(spawnNotification("v1", "wrong-turn"));
    owner.bindTurn("turn-1");

    expect(claimDirectChild).not.toHaveBeenCalled();
    await monitor.dispose();
  });

  it("keeps another bound parent from consuming V2 pre-bind evidence capacity", async () => {
    const { client, monitor } = monitorFixture();
    const firstClaim = vi.fn(() => () => undefined);
    const secondClaim = vi.fn(() => () => undefined);
    const first = await monitor.registerParent({
      parentThreadId: "parent-first",
      claimDirectChild: firstClaim,
    });
    const second = await monitor.registerParent({
      parentThreadId: "parent-second",
      claimDirectChild: secondClaim,
    });
    first.bindTurn("turn-first");

    for (const childThreadId of Array.from(
      { length: 32 },
      (_, index) => `first-unmatched-${index}`,
    )) {
      const item = directSpawnItem("v2", "parent-first", childThreadId);
      await client.item(item, "unmatched-first", "parent-first");
    }
    expect(firstClaim).not.toHaveBeenCalled();

    const secondItem = directSpawnItem("v2", "parent-second", "second-child");
    await client.item(secondItem, "turn-second", "parent-second");
    expect(secondClaim).not.toHaveBeenCalled();
    second.bindTurn("turn-second");

    expect(secondClaim).toHaveBeenCalledWith("second-child");
    expect(firstClaim).not.toHaveBeenCalled();
    // Both parents are now bound: unmatched direct evidence has no owner
    // and must not be buffered for a later registration.
    await client.item(secondItem, "wrong-parent-turn", "parent-first");
    expect(secondClaim).toHaveBeenCalledTimes(1);
    await monitor.dispose();
  });

  it("does not resurrect terminal pre-bind V1 spawn evidence", async () => {
    const { client, monitor, claimDirectChild, owner } = await directFixture();
    const item = directSpawnItem("v1", "parent-thread", "child-thread");
    await client.item(item, "turn-1");
    await client.completeNative({ result: "done" });

    owner.bindTurn("turn-1");
    expect(claimDirectChild).not.toHaveBeenCalled();
    await monitor.dispose();
  });

  it("claims only direct spawn evidence and releases before terminal delivery", async () => {
    const { client, monitor, runtime, release, claimDirectChild, owner } = await directFixture({
      ...mainRequester,
      agentId: "main",
    });
    runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
      expect(release).toHaveBeenCalledTimes(1);
      return { delivered: true, path: "direct" };
    });
    owner.bindTurn("turn-1");

    await notifyChildStarted(client);
    expect(claimDirectChild).not.toHaveBeenCalled();
    await client.notify(spawnNotification("v1", "turn-1"));
    expect(claimDirectChild).toHaveBeenCalledWith("child-thread");

    await client.completeNative({ result: "direct result" });
    expect(release).toHaveBeenCalledTimes(1);
    await monitor.dispose();
  });

  it("does not retain authority for a failed V1 spawn", async () => {
    const { client, monitor, claimDirectChild, owner } = await directFixture();
    owner.bindTurn("turn-1");

    await client.item(collabItem("spawnAgent", ["failed-child"], { status: "failed" }), "turn-1");

    expect(claimDirectChild).not.toHaveBeenCalled();
    await monitor.dispose();
  });

  it("does not reclaim a completed child while its final result is still unresolved", async () => {
    const { client, monitor, release, claimDirectChild, owner } = await directFixture();
    owner.bindTurn("turn-1");
    const spawn = directSpawnItem("v1", "parent-thread", "child-thread");
    await client.item(spawn, "turn-1");
    await client.completeTurn({ status: "completed" });
    await client.item(spawn, "turn-1");

    expect(release).toHaveBeenCalledTimes(1);
    expect(claimDirectChild).toHaveBeenCalledTimes(1);
    await monitor.dispose();
  });

  it.each(["completed", "interrupted"] as const)(
    "rejects pending direct admission when a child is observed %s before its spawn claim",
    async (status) => {
      const rejectPendingDirectChild = vi.fn();
      const { client, monitor, claimDirectChild, owner } = await directFixture({
        rejectPendingDirectChild,
      });
      owner.bindTurn("turn-1");
      await notifyChildStarted(client);
      await client.completeTurn({ status });
      await client.notify(spawnNotification("v1", "turn-1"));

      expect(rejectPendingDirectChild).toHaveBeenCalledWith(
        "child-thread",
        expect.stringContaining("Codex child turn"),
      );
      expect(claimDirectChild).not.toHaveBeenCalled();
      await monitor.dispose();
    },
  );

  function spawnNotification(version: "v1" | "v2", turnId = "parent-turn") {
    return itemNotification(directSpawnItem(version, "parent-thread", "child-thread"), turnId);
  }

  function interactionNotification(
    id: string,
    turnId = "parent-turn",
    childThreadId = "child-thread",
  ) {
    return itemNotification(
      {
        type: "subAgentActivity",
        id,
        kind: "interacted",
        agentThreadId: childThreadId,
        agentPath: `/root/${childThreadId}`,
      },
      turnId,
    );
  }

  it("observes completed V1 children again when a parent starts follow-up work", async () => {
    const { client, runtime, monitor } = monitorFixture();
    const host = await createAdmittedHostCapabilityTestFixture({
      runId: "native-followup-v1",
    });
    const relay = createCodexNativeHookRelay({
      options: { enabled: true },
      events: ["pre_tool_use"],
      agentId: undefined,
      sessionId: "native-followup-v1",
      sessionKey: undefined,
      config: {},
      runId: "native-followup-v1",
      attemptTimeoutMs: 30_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: false,
      signal: new AbortController().signal,
      hostCapabilities: host.hostCapabilities,
      onPreToolUseFailure: () => {},
    });
    if (!relay) {
      throw new Error("native hook relay missing");
    }
    onTestFinished(async () => {
      relay.unregister();
      await relay.drain();
      host.closeHost();
      host.closeAdmission();
    });
    await relay.ready;
    const claimDirectChild = vi.fn(relay.claimDirectChild);
    const onDirectChildAccepted = vi.fn();
    const owner = await registerDirect(monitor, {
      ...mainRequester,
      agentId: "main",
      claimDirectChild,
      onDirectChildAccepted,
    });
    owner.bindTurn("parent-turn");
    await client.notify(spawnNotification("v1"));
    await client.startTurn("initial-turn");
    await client.completeNative({
      turnId: "parent-turn",
      result: "first result",
    });
    await client.startTurn("followup-turn");
    onDirectChildAccepted.mockClear();
    await client.item(collabItem("sendInput", ["child-thread"], { id: "followup" }));
    await client.sendInputOutput({
      callId: "followup",
      submissionId: "followup-turn",
    });
    expect(claimDirectChild).toHaveBeenCalledTimes(2);
    expect(onDirectChildAccepted).toHaveBeenCalledOnce();
    await expect(
      invokeNativeHookRelay(
        {
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "pre_tool_use",
          rawPayload: {
            agent_id: "child-thread",
            tool_name: "Bash",
            tool_input: { command: "printf followup" },
          },
        },
        AbortSignal.timeout(1_000),
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await owner.unregister();
    await client.finishTurn(
      "followup-turn",
      agentMessage("followup-final", "second result", "final_answer"),
    );
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-thread", result: "second result" }),
    );
    await monitor.dispose();
  });

  it("moves a running child's claim to the new parent that sends its follow-up", async () => {
    const { client, monitor } = monitorFixture();
    const oldRelease = vi.fn();
    const newRelease = vi.fn();
    const oldClaim = vi.fn(() => oldRelease);
    const newClaim = vi.fn(() => newRelease);
    onTestFinished(async () => {
      await monitor.retireParent("parent-thread");
      await monitor.dispose();
    });
    const register = (claimDirectChild: typeof oldClaim) =>
      registerDirect(monitor, {
        ...mainRequester,
        claimDirectChild,
      });
    const first = await register(oldClaim);
    first.bindTurn("first-parent-turn");
    await client.notify(spawnNotification("v2", "first-parent-turn"));
    await client.startTurn("running-turn");
    await first.unregister();
    expect(oldRelease).not.toHaveBeenCalled();
    const second = await register(newClaim);
    second.bindTurn("second-parent-turn");
    await client.notify(interactionNotification("steer-running", "second-parent-turn"));
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(newClaim).toHaveBeenCalledExactlyOnceWith("child-thread");
    await client.finishTurn("running-turn", agentMessage("final", "result", "final_answer"));
    expect(newRelease).toHaveBeenCalledOnce();
    await second.unregister();
  });

  it.each(["duplicate", "fresh-unbound", "resumed-completed-first"] as const)(
    "preserves overlapping follow-up outcomes when native delivery consumes %s result",
    async (consumed) => {
      const childThreadId = "11111111-1111-4111-8111-111111111111";
      const freshOwner = consumed === "fresh-unbound";
      const resumed = consumed === "resumed-completed-first";
      const { client, runtime, monitor } = monitorFixture();
      const claim = vi.fn(() => vi.fn());
      const followupClaim = vi.fn(() => vi.fn());
      onTestFinished(() => monitor.dispose());
      const registration = {
        parentThreadId: "parent-thread",
        ...mainRequester,
        historyOwner: {
          parentThreadId: "parent-thread",
          sessionId: "parent-session",
          connectionFingerprint: "a".repeat(64),
        },
      };
      let parent = await monitor.registerParent({
        ...registration,
        claimDirectChild: claim,
      });
      parent.bindTurn("parent-turn");
      await client.item(directSpawnItem("v2", "parent-thread", childThreadId));
      const notifyCompletion = (params: Parameters<typeof childTurnCompletedNotification>[0]) =>
        client.completeTurn({ ...params, threadId: childThreadId });
      const complete = (turnId: string, result: string) =>
        notifyCompletion({
          turnId,
          status: "completed",
          items: [agentMessage(`${turnId}-final`, result, "final_answer")],
        });
      const firstResult = consumed === "duplicate" ? "same result" : "first result";
      const secondResult = consumed === "duplicate" ? "same result" : "second result";
      await complete("first-turn", firstResult);
      if (consumed === "duplicate" || freshOwner) {
        await client.completeNative({
          agentPath: `/root/${childThreadId}`,
          turnId: "parent-turn",
          result: firstResult,
        });
      }
      const parentTurnId = freshOwner ? "next-parent-turn" : "parent-turn";
      if (freshOwner) {
        await parent.unregister();
        expect(claim.mock.results[0]?.value).toHaveBeenCalledOnce();
        parent = await monitor.registerParent({
          ...registration,
          claimDirectChild: followupClaim,
          modelSource: undefined,
        });
        const receiver = threadRead({
          childThreadId,
          turnId: "first-turn",
          result: firstResult,
          agentPath: `/root/${childThreadId}`,
          threadStatus: "idle",
        });
        receiver.thread.modelProvider = "test-provider";
        client.setThreadRead(childThreadId, receiver);
        const admitInput = () =>
          monitor.prepareModelInput({
            threadId: "parent-thread",
            turnId: parentTurnId,
            itemId: "followup",
            target: childThreadId,
            readQualification: () => undefined,
            assertCurrent: () => {},
          });
        await expect(admitInput()).rejects.toThrow("exact admitted sender turn");
        expect(followupClaim).not.toHaveBeenCalled();
        parent.bindTurn(parentTurnId);
        await admitInput();
      }
      await client.notify(interactionNotification("followup", parentTurnId, childThreadId));
      expect(claim).toHaveBeenCalledOnce();
      await client.startTurn("followup-turn", { threadId: childThreadId });
      expect(claim).toHaveBeenCalledTimes(freshOwner ? 1 : 2);
      if (freshOwner) {
        expect(followupClaim).toHaveBeenCalledOnce();
      }
      await complete("first-turn", "stale result");
      if (resumed) {
        await notifyCompletion({ turnId: "followup-turn", status: "interrupted" });
        const interact = () =>
          client.notify(interactionNotification("resume-followup", parentTurnId, childThreadId));
        await client.startTurn("resumed-turn", { threadId: childThreadId });
        await complete("resumed-turn", secondResult);
        await interact();
        expect(claim).toHaveBeenCalledTimes(2);
      }
      await complete(resumed ? "resumed-turn" : "followup-turn", secondResult);
      if (resumed) {
        await client.startTurn("unadmitted-turn", { threadId: childThreadId });
        expect(claim).toHaveBeenCalledTimes(2);
      }
      if (consumed === "duplicate") {
        await client.item(
          collabItem("wait", [childThreadId], {
            id: "late-wait",
            agentsStates: { [childThreadId]: { status: "completed", message: firstResult } },
          }),
        );
      }
      await parent.unregister();
      await vi.waitFor(() =>
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(resumed ? 2 : 1),
      );
      const delivered = runtime.deliverAgentHarnessCompletion.mock.calls.map(
        ([params]) => params.result,
      );
      expect(delivered).toEqual(
        consumed === "duplicate" || freshOwner ? [secondResult] : ["first result", "second result"],
      );
    },
  );

  it("keeps follow-up admission through repeated active predecessor history", async () => {
    const { client, monitor, claimDirectChild, owner } = await directFixture(mainRequester);
    client.setThreadRead(
      "child-thread",
      threadRead({ turnId: "turn-a", status: "inProgress", threadStatus: "active" }),
    );
    onTestFinished(() => monitor.dispose());
    owner.bindTurn("parent-turn");
    await notifyChildStarted(client);
    await client.startTurn("turn-a");
    await client.item({
      type: "subAgentActivity",
      kind: "interacted",
      agentThreadId: "child-thread",
    });
    await monitor.reconcileChildThread("child-thread");
    await monitor.reconcileChildThread("child-thread");
    await client.finishTurn("turn-a", agentMessage("first-result", "first result"));
    await client.startTurn("turn-b");
    expect(claimDirectChild).toHaveBeenCalledTimes(2);
    await owner.unregister();
  });

  it("releases direct authority when history ends a native turn before its final text arrives", async () => {
    const { client, monitor, owner, release } = await directFixture();
    onTestFinished(() => monitor.dispose());
    owner.bindTurn("parent-turn");
    await client.notify(spawnNotification("v2"));
    await client.startTurn("turn-1");
    client.setThreadRead("child-thread", threadRead({ status: "completed" }));
    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
