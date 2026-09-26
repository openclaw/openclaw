import { describe, expect, it, vi } from "vitest";
import {
  type CodexThreadReadResponse,
  directSpawnItem,
  successfulSendInputOutput,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createCompletionScope,
  registerParent,
  notifyChildStarted,
  nativeCompletionNotification,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
  createNativeModelSourceFixture as modelSource,
  requireNativeModelSourceCapture as requireCapture,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification } from "./protocol.js";

describe("CodexNativeSubagentMonitor", () => {
  it("keeps A during an accepted B follow-up and gives the new child turn only B's ceiling", async () => {
    const client = createClient();
    const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime(), {
      recoveryPollDelaysMs: [],
    });
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
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-a",
        item: directSpawnItem("v2", "parent-thread", "child-thread"),
      },
    });
    const original = requireCapture(await waitingForReceipt);
    expect(monitor.resolveModelThreadId("child-a")).toBe("child-thread");
    expect(original.modelMapping).toEqual(mappingA);
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-a",
        item: {
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          id: "same-source-steer",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
        },
      },
    });
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
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-b",
        item: {
          type: "subAgentActivity",
          kind: "interacted",
          id: "accepted-followup",
          agentThreadId: "child-thread",
          agentPath: "/root/child-thread",
        },
      },
    });
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
    monitor.dispose();
    expect(a.release).toHaveBeenCalledOnce();
  });

  it("retains nested admitted work and fences only the cancelled execution across regrant", async () => {
    const client = createClient();
    const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime(), {
      recoveryPollDelaysMs: [],
    });
    const source = modelSource(["model-a", "model-b"]);
    const parent = await monitor.registerParent({
      parentThreadId: "parent-thread",
      modelSource: source,
    });
    parent.bindTurn("parent-turn");
    for (const child of ["child-a", "child-b"]) {
      await notifyChildStarted(client, "parent-thread", child);
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: directSpawnItem("v2", "parent-thread", child),
        },
      });
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
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "child-b",
        turnId: "child-b-turn",
        item: directSpawnItem("v2", "child-b", "grandchild"),
      },
    });
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
    monitor.dispose();
    expect(monitor.resolveModelThreadId("grandchild-turn")).toBeUndefined();
    expect(source.release).toHaveBeenCalledOnce();
  });

  it("does not accept parent commentary as a native child result or delivery receipt", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    const parent = await registerParent(monitor);
    parent.bindTurn("parent-turn");
    await notifyChildStarted(client);
    await client.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                author: "child-thread",
                recipient: "/root",
                content:
                  '<subagent_notification>{"agent_path":"child-thread","status":{"completed":"child result"}}</subagent_notification>',
                trigger_turn: false,
              }),
            },
          ],
        },
      },
    });

    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();

    await client.notify(
      childTurnCompletedNotification({
        status: "completed",
        items: [
          { type: "agentMessage", id: "child-final", phase: "final_answer", text: "child result" },
        ],
      }),
    );
    await parent.unregister();

    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ result: "child result" }),
    );
    client.close();
  });

  it.each(["v1", "v2"] as const)(
    "buffers direct %s spawn evidence until its exact parent turn binds",
    async (version) => {
      const client = createClient();
      const claimDirectChild = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
      const owner = await monitor.registerParent({
        parentThreadId: "parent-thread",
        claimDirectChild,
      });
      const item = directSpawnItem(version, "parent-thread", "child-thread");

      await client.notify({
        method: "item/completed",
        params: { threadId: "parent-thread", turnId: "turn-1", item },
      } as unknown as CodexServerNotification);
      expect(claimDirectChild).not.toHaveBeenCalled();

      owner.bindTurn("turn-1");
      expect(claimDirectChild).toHaveBeenCalledTimes(1);
      expect(claimDirectChild).toHaveBeenCalledWith("child-thread");
      monitor.dispose();
    },
  );

  it("does not consume pre-bind direct spawn evidence for another turn", async () => {
    const client = createClient();
    const claimDirectChild = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild,
    });

    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "wrong-turn",
        item: directSpawnItem("v1", "parent-thread", "child-thread"),
      },
    });
    owner.bindTurn("turn-1");

    expect(claimDirectChild).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it.each(["v1", "v2"] as const)(
    "keeps another bound parent from consuming %s pre-bind evidence capacity",
    async (version) => {
      const client = createClient();
      const firstClaim = vi.fn(() => () => undefined);
      const secondClaim = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
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
        const item = directSpawnItem(version, "parent-first", childThreadId);
        await client.notify({
          method: "item/completed",
          params: { threadId: "parent-first", turnId: "unmatched-first", item },
        } as unknown as CodexServerNotification);
      }
      expect(firstClaim).not.toHaveBeenCalled();

      const secondItem = directSpawnItem(version, "parent-second", "second-child");
      await client.notify({
        method: "item/completed",
        params: { threadId: "parent-second", turnId: "turn-second", item: secondItem },
      } as unknown as CodexServerNotification);
      second.bindTurn("turn-second");

      expect(secondClaim).toHaveBeenCalledWith("second-child");
      expect(firstClaim).not.toHaveBeenCalled();
      // Both parents are now bound: unmatched direct evidence has no owner
      // and must not be buffered for a later registration.
      await client.notify({
        method: "item/completed",
        params: { threadId: "parent-first", turnId: "wrong-parent-turn", item: secondItem },
      } as unknown as CodexServerNotification);
      expect(secondClaim).toHaveBeenCalledTimes(1);
      monitor.dispose();
    },
  );

  it.each(["v1", "v2"] as const)(
    "does not resurrect terminal pre-bind %s spawn evidence",
    async (version) => {
      const client = createClient();
      const claimDirectChild = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
      const owner = await monitor.registerParent({
        parentThreadId: "parent-thread",
        claimDirectChild,
      });
      const item = directSpawnItem(version, "parent-thread", "child-thread");
      await client.notify({
        method: "item/completed",
        params: { threadId: "parent-thread", turnId: "turn-1", item },
      } as unknown as CodexServerNotification);
      await client.notify(nativeCompletionNotification({ result: "done" }));

      owner.bindTurn("turn-1");
      expect(claimDirectChild).not.toHaveBeenCalled();
      monitor.dispose();
    },
  );

  it("claims only direct spawn evidence and releases before terminal delivery", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const release = vi.fn();
    runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
      expect(release).toHaveBeenCalledTimes(1);
      return { delivered: true, path: "direct" };
    });
    const claimDirectChild = vi.fn(() => release);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
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
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        item: directSpawnItem("v1", "parent-thread", "child-thread"),
      },
    });
    expect(claimDirectChild).toHaveBeenCalledWith("child-thread");

    await client.notify(
      nativeCompletionNotification({ agentPath: "child-thread", result: "direct result" }),
    );
    expect(release).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("does not retain authority for a failed V1 spawn", async () => {
    const client = createClient();
    const claimDirectChild = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild,
    });
    owner.bindTurn("turn-1");

    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "failed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["failed-child"],
        },
      },
    });

    expect(claimDirectChild).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it.each(["v1", "v2"] as const)(
    "does not reclaim a terminal child from late %s spawn evidence",
    async (version) => {
      const client = createClient();
      const claimDirectChild = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
      const owner = await monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        completionScope: createCompletionScope("agent:main:main"),
        claimDirectChild,
      });
      owner.bindTurn("turn-1");
      const item = directSpawnItem(version, "parent-thread", "child-thread");
      await client.notify({
        method: "item/completed",
        params: { threadId: "parent-thread", turnId: "turn-1", item },
      } as unknown as CodexServerNotification);
      expect(claimDirectChild).toHaveBeenCalledTimes(1);

      await client.notify(
        nativeCompletionNotification({ agentPath: "child-thread", result: "done" }),
      );
      await client.notify({
        method: "item/completed",
        params: { threadId: "parent-thread", turnId: "turn-1", item },
      } as unknown as CodexServerNotification);

      expect(claimDirectChild).toHaveBeenCalledTimes(1);
      monitor.dispose();
    },
  );

  it("does not reclaim an interrupted child from later V1 spawn evidence", async () => {
    const client = createClient();
    const claimDirectChild = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild,
    });
    owner.bindTurn("turn-1");
    const spawn = directSpawnItem("v1", "parent-thread", "child-thread");
    await client.notify({
      method: "item/completed",
      params: { threadId: "parent-thread", turnId: "turn-1", item: spawn },
    });
    await client.notify(childTurnCompletedNotification({ status: "interrupted" }));
    await client.notify({
      method: "item/completed",
      params: { threadId: "parent-thread", turnId: "turn-1", item: spawn },
    });

    expect(claimDirectChild).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("does not reclaim a completed child while its final result is still unresolved", async () => {
    const client = createClient();
    const release = vi.fn();
    const claimDirectChild = vi.fn(() => release);
    const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild,
    });
    owner.bindTurn("turn-1");
    const spawn = directSpawnItem("v1", "parent-thread", "child-thread");
    await client.notify({
      method: "item/completed",
      params: { threadId: "parent-thread", turnId: "turn-1", item: spawn },
    });
    await client.notify(childTurnCompletedNotification({ status: "completed" }));
    await client.notify({
      method: "item/completed",
      params: { threadId: "parent-thread", turnId: "turn-1", item: spawn },
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(claimDirectChild).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "rejects pending direct admission when a child is observed %s before its spawn claim",
    async (status) => {
      const client = createClient();
      const rejectPendingDirectChild = vi.fn();
      const claimDirectChild = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
      const owner = await monitor.registerParent({
        parentThreadId: "parent-thread",
        claimDirectChild,
        rejectPendingDirectChild,
      });
      owner.bindTurn("turn-1");
      await notifyChildStarted(client);
      await client.notify(childTurnCompletedNotification({ status }));
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          item: directSpawnItem("v1", "parent-thread", "child-thread"),
        },
      });

      expect(rejectPendingDirectChild).toHaveBeenCalledWith(
        "child-thread",
        expect.stringContaining("Codex child turn"),
      );
      expect(claimDirectChild).not.toHaveBeenCalled();
      monitor.dispose();
    },
  );

  it("releases terminal tombstones when their parent registration closes", async () => {
    const client = createClient();
    const firstClaim = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
    const first = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild: firstClaim,
    });
    first.bindTurn("turn-1");
    for (const childThreadId of ["terminal-child-1", "terminal-child-2", "terminal-child-3"]) {
      await notifyChildStarted(client, "parent-thread", childThreadId, childThreadId);
      await client.notify(
        nativeCompletionNotification({ agentPath: childThreadId, result: "done" }),
      );
    }

    await first.unregister();
    const nextClaim = vi.fn(() => () => undefined);
    const next = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild: nextClaim,
    });
    next.bindTurn("turn-2");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-2",
        item: directSpawnItem("v1", "parent-thread", "terminal-child-1"),
      },
    });

    expect(firstClaim).not.toHaveBeenCalled();
    expect(nextClaim).toHaveBeenCalledWith("terminal-child-1");
    monitor.dispose();
  });

  it("collects a terminal revision after its last held reader releases", async () => {
    const client = createClient();
    let resolveRead: ((value: CodexThreadReadResponse) => void) | undefined;
    const pendingRead = new Promise<CodexThreadReadResponse>((resolve) => {
      resolveRead = resolve;
    });
    client.setThreadReadFactory("child-thread", async () => await pendingRead);
    const firstClaim = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
    const first = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild: firstClaim,
    });
    first.bindTurn("turn-1");
    await notifyChildStarted(client);
    const reconciliation = monitor.reconcileChildThread("child-thread");
    await client.notify(nativeCompletionNotification({ result: "done" }));
    await first.unregister();
    resolveRead?.(threadRead({ status: "inProgress" }));
    await reconciliation;

    const nextClaim = vi.fn(() => () => undefined);
    const next = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild: nextClaim,
    });
    next.bindTurn("turn-2");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-2",
        item: directSpawnItem("v1", "parent-thread", "child-thread"),
      },
    });

    expect(firstClaim).not.toHaveBeenCalled();
    expect(nextClaim).toHaveBeenCalledWith("child-thread");
    monitor.dispose();
  });
});
