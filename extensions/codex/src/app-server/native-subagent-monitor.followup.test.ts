import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCodexNativeHookRelay } from "./native-hook-relay.js";
import {
  directSpawnItem,
  successfulSendInputOutput,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  notifyChildStarted,
  threadRead,
  createCompletionScope,
  nativeCompletionNotification,
  childTurnCompletedNotification,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";

function itemNotification(
  item: JsonObject,
  turnId = "parent-turn",
  threadId = "parent-thread",
): CodexServerNotification {
  return { method: "item/completed", params: { threadId, turnId, item } };
}

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
