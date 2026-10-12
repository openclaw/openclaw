import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { createCodexNativeHookRelay } from "./native-hook-relay.js";
import {
  directSpawnItem,
  successfulSendInputOutput,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createCompletionScope,
  notifyChildStarted,
  nativeCompletionNotification,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
  createNativeModelSourceFixture as modelSource,
  requireNativeModelSourceCapture as requireCapture,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";

function itemNotification(
  item: JsonObject,
  turnId = "parent-turn",
  threadId = "parent-thread",
): CodexServerNotification {
  return { method: "item/completed", params: { threadId, turnId, item } };
}

function monitorFixture(options?: ConstructorParameters<typeof CodexNativeSubagentMonitor>[2]) {
  const client = createClient();
  const runtime = createRuntime();
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, options);
  return { client, runtime, monitor };
}

describe("CodexNativeSubagentMonitor", () => {
  it("keeps A during an accepted B follow-up and gives the new child turn only B's ceiling", async () => {
    const { client, monitor } = monitorFixture({ recoveryPollDelaysMs: [] });
    const a = modelSource(["model-a"]);
    const b = modelSource(["model-b"]);
    const mappingA = {
      nativeModel: { provider: "test-provider", model: "wire-a" },
      authorizedModel: { provider: "test-provider", model: "model-a" },
    };
    const mappingB = {
      nativeModel: { provider: "test-provider", model: "wire-b" },
      authorizedModel: { provider: "test-provider", model: "model-b" },
    };
    const first = await monitor.registerParent({ parentThreadId: "parent-thread", modelSource: a });
    first.bindTurn("parent-a", mappingA);
    await notifyChildStarted(client);
    await client.notify(turnStartedNotification("child-a"));
    const originalRequest = {
      threadId: "child-thread",
      turnId: "child-a",
      parentThreadId: "parent-thread",
      parentTurnId: "parent-a",
      rootTurnId: "parent-a",
    };
    const waitingForReceipt = monitor.captureModelSource(originalRequest);
    await client.notify(
      itemNotification(directSpawnItem("v2", "parent-thread", "child-thread"), "parent-a"),
    );
    const original = requireCapture(await waitingForReceipt);
    expect(monitor.resolveModelThreadId("child-a")).toBe("child-thread");
    expect(original.modelMapping).toEqual(mappingA);
    await client.notify(
      itemNotification(
        {
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          id: "same-source-steer",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
        },
        "parent-a",
      ),
    );
    await client.notify(
      successfulSendInputOutput({
        turnId: "parent-a",
        callId: "same-source-steer",
        submissionId: "opaque-steer-receipt",
      }),
    );
    await first.unregister();
    expect(
      await monitor.captureModelSource({ ...originalRequest, turnId: "unrelated-turn" }),
    ).toBeUndefined();
    const second = await monitor.registerParent({
      parentThreadId: "parent-thread",
      modelSource: b,
    });
    second.bindTurn("parent-b", mappingB);
    await client.notify(
      itemNotification(
        {
          type: "subAgentActivity",
          kind: "interacted",
          id: "accepted-followup",
          agentThreadId: "child-thread",
          agentPath: "/root/child-thread",
        },
        "parent-b",
      ),
    );
    await second.unregister();
    expect(monitor.resolveModelThreadId("child-b")).toBeUndefined();
    const stillA = requireCapture(await monitor.captureModelSource(originalRequest));
    expect(stillA.modelMapping).toEqual(mappingA);
    expect(
      stillA.source?.bindModelExecution?.({ provider: "test-provider", model: "model-a" }),
    ).toBeDefined();
    expect(() =>
      stillA.source?.bindModelExecution?.({ provider: "test-provider", model: "model-b" }),
    ).toThrow("does not admit");
    expect(b.release).not.toHaveBeenCalled();
    stillA.release();
    await client.notify(
      childTurnCompletedNotification({
        turnId: "child-a",
        status: "completed",
        items: [{ type: "agentMessage", id: "a-final", text: "A finished" }],
      }),
    );
    expect(a.release).not.toHaveBeenCalled();
    original.release();
    expect(a.release).not.toHaveBeenCalled();
    await client.notify(turnStartedNotification("child-b"));
    const next = requireCapture(
      await monitor.captureModelSource({
        ...originalRequest,
        turnId: "child-b",
        parentTurnId: "parent-b",
        rootTurnId: "parent-b",
      }),
    );
    expect(next.modelMapping).toEqual(mappingB);
    expect(
      next.source?.bindModelExecution?.({ provider: "test-provider", model: "model-b" }),
    ).toBeDefined();
    expect(() =>
      next.source?.bindModelExecution?.({ provider: "test-provider", model: "model-a" }),
    ).toThrow("does not admit");
    await client.notify(
      childTurnCompletedNotification({
        turnId: "child-b",
        status: "completed",
        items: [{ type: "agentMessage", id: "b-final", text: "B finished" }],
      }),
    );
    next.release();
    expect(monitor.resolveModelThreadId("child-b")).toBeUndefined();
    expect(b.release).toHaveBeenCalledOnce();
    const disposal = monitor.dispose();
    expect(a.release).toHaveBeenCalledOnce();
    await disposal;
  });

  it("retains nested admitted work and fences only the cancelled execution across regrant", async () => {
    const { client, monitor } = monitorFixture({ recoveryPollDelaysMs: [] });
    const source = modelSource(["model-a", "model-b"]);
    const parent = await monitor.registerParent({
      parentThreadId: "parent-thread",
      modelSource: source,
    });
    parent.bindTurn("parent-turn");
    for (const child of ["child-a", "child-b"]) {
      await notifyChildStarted(client, "parent-thread", child);
      await client.notify(itemNotification(directSpawnItem("v2", "parent-thread", child)));
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
    const first = requireCapture(await monitor.captureModelSource(requestA));
    expect(monitor.resolveModelThreadId("child-a-turn")).toBe("child-a");
    first.recordNativeReviewRequirement(true);
    first.cancel();
    expect(monitor.resolveModelThreadId("child-a-turn")).toBeUndefined();
    expect(monitor.resolveModelThreadId("child-b-turn")).toBe("child-b");
    expect(() => first.assertCurrent()).toThrow("execution was cancelled");
    await expect(monitor.captureModelSource(requestA)).rejects.toThrow("execution was cancelled");
    const sibling = requireCapture(
      await monitor.captureModelSource({
        ...requestA,
        threadId: "child-b",
        turnId: "child-b-turn",
      }),
    );
    expect(sibling.nativeReviewRequired).toBe(false);
    expect(
      sibling.source?.bindModelExecution?.({ provider: "test-provider", model: "model-b" }),
    ).toBeDefined();
    await notifyChildStarted(client, "child-b", "grandchild", "/root/child-b/grandchild");
    await client.notify(
      itemNotification(directSpawnItem("v2", "child-b", "grandchild"), "child-b-turn", "child-b"),
    );
    await client.notify({
      method: "turn/started",
      params: { threadId: "grandchild", turn: { id: "grandchild-turn" } },
    });
    await parent.unregister();
    const nested = requireCapture(
      await monitor.captureModelSource({
        threadId: "grandchild",
        turnId: "grandchild-turn",
        parentThreadId: "child-b",
        parentTurnId: "child-b-turn",
        rootTurnId: "parent-turn",
      }),
    );
    expect(
      nested.source?.bindModelExecution?.({ provider: "test-provider", model: "model-b" }),
    ).toBeDefined();
    first.release();
    sibling.release();
    nested.release();
    const disposal = monitor.dispose();
    expect(monitor.resolveModelThreadId("grandchild-turn")).toBeUndefined();
    expect(source.release).toHaveBeenCalledOnce();
    await disposal;
  });

  it("does not consume pre-bind direct spawn evidence for another turn", async () => {
    const { client, monitor } = monitorFixture();
    const claimDirectChild = vi.fn(() => () => undefined);
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild,
    });

    await client.notify(
      itemNotification(directSpawnItem("v1", "parent-thread", "child-thread"), "wrong-turn"),
    );
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
      await client.notify(itemNotification(item, "unmatched-first", "parent-first"));
    }
    expect(firstClaim).not.toHaveBeenCalled();

    const secondItem = directSpawnItem("v2", "parent-second", "second-child");
    await client.notify(itemNotification(secondItem, "turn-second", "parent-second"));
    expect(secondClaim).not.toHaveBeenCalled();
    second.bindTurn("turn-second");

    expect(secondClaim).toHaveBeenCalledWith("second-child");
    expect(firstClaim).not.toHaveBeenCalled();
    // Both parents are now bound: unmatched direct evidence has no owner
    // and must not be buffered for a later registration.
    await client.notify(itemNotification(secondItem, "wrong-parent-turn", "parent-first"));
    expect(secondClaim).toHaveBeenCalledTimes(1);
    await monitor.dispose();
  });

  it("does not resurrect terminal pre-bind V1 spawn evidence", async () => {
    const { client, monitor } = monitorFixture();
    const claimDirectChild = vi.fn(() => () => undefined);
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild,
    });
    const item = directSpawnItem("v1", "parent-thread", "child-thread");
    await client.notify(itemNotification(item, "turn-1"));
    await client.notify(nativeCompletionNotification({ result: "done" }));

    owner.bindTurn("turn-1");
    expect(claimDirectChild).not.toHaveBeenCalled();
    await monitor.dispose();
  });

  it("claims only direct spawn evidence and releases before terminal delivery", async () => {
    const { client, monitor, runtime } = monitorFixture();
    const release = vi.fn();
    runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
      expect(release).toHaveBeenCalledTimes(1);
      return { delivered: true, path: "direct" };
    });
    const claimDirectChild = vi.fn(() => release);
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      completionScope: createCompletionScope("agent:main:main"),
      agentId: "main",
      claimDirectChild,
    });
    owner.bindTurn("turn-1");

    await notifyChildStarted(client);
    expect(claimDirectChild).not.toHaveBeenCalled();
    await client.notify(
      itemNotification(directSpawnItem("v1", "parent-thread", "child-thread"), "turn-1"),
    );
    expect(claimDirectChild).toHaveBeenCalledWith("child-thread");

    await client.notify(
      nativeCompletionNotification({ agentPath: "child-thread", result: "direct result" }),
    );
    expect(release).toHaveBeenCalledTimes(1);
    await monitor.dispose();
  });

  it("does not retain authority for a failed V1 spawn", async () => {
    const { client, monitor } = monitorFixture();
    const claimDirectChild = vi.fn(() => () => undefined);
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild,
    });
    owner.bindTurn("turn-1");

    await client.notify(
      itemNotification(
        {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "failed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["failed-child"],
        },
        "turn-1",
      ),
    );

    expect(claimDirectChild).not.toHaveBeenCalled();
    await monitor.dispose();
  });

  it("does not reclaim a completed child while its final result is still unresolved", async () => {
    const { client, monitor } = monitorFixture();
    const release = vi.fn();
    const claimDirectChild = vi.fn(() => release);
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild,
    });
    owner.bindTurn("turn-1");
    const spawn = directSpawnItem("v1", "parent-thread", "child-thread");
    await client.notify(itemNotification(spawn, "turn-1"));
    await client.notify(childTurnCompletedNotification({ status: "completed" }));
    await client.notify(itemNotification(spawn, "turn-1"));

    expect(release).toHaveBeenCalledTimes(1);
    expect(claimDirectChild).toHaveBeenCalledTimes(1);
    await monitor.dispose();
  });

  it.each(["completed", "interrupted"] as const)(
    "rejects pending direct admission when a child is observed %s before its spawn claim",
    async (status) => {
      const { client, monitor } = monitorFixture();
      const rejectPendingDirectChild = vi.fn();
      const claimDirectChild = vi.fn(() => () => undefined);
      const owner = await monitor.registerParent({
        parentThreadId: "parent-thread",
        claimDirectChild,
        rejectPendingDirectChild,
      });
      owner.bindTurn("turn-1");
      await notifyChildStarted(client);
      await client.notify(childTurnCompletedNotification({ status }));
      await client.notify(
        itemNotification(directSpawnItem("v1", "parent-thread", "child-thread"), "turn-1"),
      );

      expect(rejectPendingDirectChild).toHaveBeenCalledWith(
        "child-thread",
        expect.stringContaining("Codex child turn"),
      );
      expect(claimDirectChild).not.toHaveBeenCalled();
      await monitor.dispose();
    },
  );
});

function interactionNotification(
  id: string,
  turnId = "parent-turn",
  childThreadId = "child-thread",
) {
  return {
    method: "item/completed",
    params: {
      threadId: "parent-thread",
      turnId,
      item: {
        type: "subAgentActivity",
        id,
        kind: "interacted",
        agentThreadId: childThreadId,
        agentPath: `/root/${childThreadId}`,
      },
    },
  };
}

describe("CodexNativeSubagentMonitor", () => {
  it("observes completed V1 children again when a parent starts follow-up work", async () => {
    const client = createClient();
    const runtime = createRuntime();
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
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      completionScope: createCompletionScope("agent:main:main"),
      agentId: "main",
      claimDirectChild,
      onDirectChildAccepted,
    });
    owner.bindTurn("parent-turn");
    await client.notify(itemNotification(directSpawnItem("v1", "parent-thread", "child-thread")));
    await client.notify(turnStartedNotification("initial-turn", { error: null }));
    await client.notify(
      nativeCompletionNotification({
        agentPath: "child-thread",
        turnId: "parent-turn",
        result: "first result",
      }),
    );
    await client.notify(turnStartedNotification("followup-turn", { error: null }));
    onDirectChildAccepted.mockClear();
    await client.notify(
      itemNotification({
        type: "collabAgentToolCall",
        id: "followup",
        tool: "sendInput",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
      }),
    );
    await client.notify(
      successfulSendInputOutput({ callId: "followup", submissionId: "followup-turn" }),
    );
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
    await client.notify({
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: {
          id: "followup-turn",
          status: "completed",
          error: null,
          items: [
            {
              type: "agentMessage",
              id: "followup-final",
              phase: "final_answer",
              text: "second result",
            },
          ],
        },
      },
    });
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-thread", result: "second result" }),
    );
    await monitor.dispose();
  });

  it("moves a running child's claim to the new parent that sends its follow-up", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const oldRelease = vi.fn();
    const newRelease = vi.fn();
    const oldClaim = vi.fn(() => oldRelease);
    const newClaim = vi.fn(() => newRelease);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    onTestFinished(async () => {
      await monitor.retireParent("parent-thread");
      await monitor.dispose();
    });
    const register = (claimDirectChild: typeof oldClaim) =>
      monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        completionScope: createCompletionScope("agent:main:main"),
        claimDirectChild,
      });
    const first = await register(oldClaim);
    first.bindTurn("first-parent-turn");
    await client.notify(
      itemNotification(directSpawnItem("v2", "parent-thread", "child-thread"), "first-parent-turn"),
    );
    await client.notify(turnStartedNotification("running-turn", { error: null }));
    await first.unregister();
    expect(oldRelease).not.toHaveBeenCalled();
    const second = await register(newClaim);
    second.bindTurn("second-parent-turn");
    await client.notify(interactionNotification("steer-running", "second-parent-turn"));
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(newClaim).toHaveBeenCalledExactlyOnceWith("child-thread");
    await client.notify(
      childTurnCompletedNotification({
        turnId: "running-turn",
        status: "completed",
        items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "result" }],
      }),
    );
    expect(newRelease).toHaveBeenCalledOnce();
    await second.unregister();
  });

  it.each(["duplicate", "fresh-unbound", "resumed-completed-first"] as const)(
    "preserves overlapping follow-up outcomes when native delivery consumes %s result",
    async (consumed) => {
      const childThreadId = "11111111-1111-4111-8111-111111111111";
      const freshOwner = consumed === "fresh-unbound";
      const resumed = consumed === "resumed-completed-first";
      const client = createClient();
      const runtime = createRuntime();
      const claim = vi.fn(() => vi.fn());
      const followupClaim = vi.fn(() => vi.fn());
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      onTestFinished(() => monitor.dispose());
      const registration = {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        completionScope: createCompletionScope("agent:main:main"),
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
      await client.notify(itemNotification(directSpawnItem("v2", "parent-thread", childThreadId)));
      const notifyCompletion = (params: Parameters<typeof childTurnCompletedNotification>[0]) =>
        client.notify(childTurnCompletedNotification({ ...params, threadId: childThreadId }));
      const complete = (turnId: string, result: string) =>
        notifyCompletion({
          turnId,
          status: "completed",
          items: [
            { type: "agentMessage", id: `${turnId}-final`, phase: "final_answer", text: result },
          ],
        });
      const firstResult = consumed === "duplicate" ? "same result" : "first result";
      const secondResult = consumed === "duplicate" ? "same result" : "second result";
      await complete("first-turn", firstResult);
      if (consumed === "duplicate" || freshOwner) {
        await client.notify(
          nativeCompletionNotification({
            agentPath: `/root/${childThreadId}`,
            turnId: "parent-turn",
            result: firstResult,
          }),
        );
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
      await client.notify(
        turnStartedNotification("followup-turn", { threadId: childThreadId, error: null }),
      );
      expect(claim).toHaveBeenCalledTimes(freshOwner ? 1 : 2);
      if (freshOwner) {
        expect(followupClaim).toHaveBeenCalledOnce();
      }
      await complete("first-turn", "stale result");
      if (resumed) {
        await notifyCompletion({ turnId: "followup-turn", status: "interrupted" });
        const interact = () =>
          client.notify(interactionNotification("resume-followup", parentTurnId, childThreadId));
        await client.notify(
          turnStartedNotification("resumed-turn", { threadId: childThreadId, error: null }),
        );
        await complete("resumed-turn", secondResult);
        await interact();
        expect(claim).toHaveBeenCalledTimes(2);
      }
      await complete(resumed ? "resumed-turn" : "followup-turn", secondResult);
      if (resumed) {
        await client.notify(
          turnStartedNotification("unadmitted-turn", { threadId: childThreadId, error: null }),
        );
        expect(claim).toHaveBeenCalledTimes(2);
      }
      if (consumed === "duplicate") {
        await client.notify(
          itemNotification({
            type: "collabAgentToolCall",
            id: "late-wait",
            tool: "wait",
            status: "completed",
            senderThreadId: "parent-thread",
            receiverThreadIds: [childThreadId],
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
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({ turnId: "turn-a", status: "inProgress", threadStatus: "active" }),
    );
    const runtime = createRuntime();
    const claimDirectChild = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    onTestFinished(() => monitor.dispose());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      completionScope: createCompletionScope("agent:main:main"),
      claimDirectChild,
    });
    owner.bindTurn("parent-turn");
    await notifyChildStarted(client);
    await client.notify(turnStartedNotification("turn-a"));
    await client.notify(
      itemNotification({
        type: "subAgentActivity",
        kind: "interacted",
        agentThreadId: "child-thread",
      }),
    );
    await monitor.reconcileChildThread("child-thread");
    await monitor.reconcileChildThread("child-thread");
    await client.notify(
      childTurnCompletedNotification({
        turnId: "turn-a",
        status: "completed",
        items: [{ id: "first-result", type: "agentMessage", text: "first result" }],
      }),
    );
    await client.notify(turnStartedNotification("turn-b"));
    expect(claimDirectChild).toHaveBeenCalledTimes(2);
    await owner.unregister();
  });

  it("releases direct authority when history ends a native turn before its final text arrives", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const releaseClaim = vi.fn();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    onTestFinished(() => monitor.dispose());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild: () => releaseClaim,
    });
    owner.bindTurn("parent-turn");
    await client.notify(itemNotification(directSpawnItem("v2", "parent-thread", "child-thread")));
    await client.notify(turnStartedNotification("turn-1", { error: null }));
    client.setThreadRead("child-thread", threadRead({ status: "completed" }));
    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);
    expect(releaseClaim).toHaveBeenCalledOnce();
  });
});
