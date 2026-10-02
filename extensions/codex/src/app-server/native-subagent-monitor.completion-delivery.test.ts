import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import {
  buildEmptyToolTelemetry,
  CodexAppServerEventProjector,
  createParams,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createCompletionScope,
  registerParent,
  notifyChildStarted,
  successfulSendInputOutput,
  nativeCompletionNotification,
  nativeHistoryOwner,
  deliveredNativeCompletion,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentAssignmentStore } from "./native-subagent-pending-assignments.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";

function itemNotification(
  item: JsonObject,
  turnId = "parent-turn",
  threadId = "parent-thread",
): CodexServerNotification {
  return { method: "item/completed", params: { threadId, turnId, item } };
}

async function registerRuntimeOwner(
  client: ReturnType<typeof createClient>,
  runtime: ReturnType<typeof createRuntime>,
) {
  ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/agent" });
  return codexNativeSubagentMonitorRuntime.register({
    client: client.client,
    parentThreadId: "parent-thread",
    requesterSessionKey: "agent:main:discord:channel:C123",
    completionScope: createCompletionScope(),
    agentId: "main",
    runtime,
  });
}

function completedChild(turnId = "child-turn", text = "The build passed.", id = "child-final") {
  return childTurnCompletedNotification({
    status: "completed",
    turnId,
    items: [{ type: "agentMessage", id, phase: "final_answer", text }],
  });
}

describe("CodexNativeSubagentMonitor", () => {
  describe("native completion delivery ownership", () => {
    registerCodexEventProjectorTestLifecycle();

    it("does not repeat a shutdown result returned by native wait", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime);
      const parent = await registerParent(monitor);
      parent.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(
        itemNotification({
          type: "collabAgentToolCall",
          id: "wait-call",
          tool: "wait",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "shutdown", message: null } },
        }),
      );
      await client.notify(
        nativeCompletionNotification({ statusLabel: "shutdown", turnId: "parent-turn" }),
      );
      await parent.unregister();
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      await monitor.dispose();
    });

    it.each([
      {
        receipt: "agent-message",
        order: "native-first",
      },
      {
        receipt: "contextual",
        order: "terminal-first",
      },
    ])(
      "preserves the parent answer when $receipt delivery and child completion arrive $order",
      async ({ receipt, order }) => {
        const final = "The build passed. The change is ready.";
        const client = createClient();
        const runtime = createRuntime();
        const owner = await registerRuntimeOwner(client, runtime);
        owner.bindTurn("parent-turn");
        await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
        const projector = new CodexAppServerEventProjector(
          await createParams(),
          "parent-thread",
          "parent-turn",
        );
        let lastAnswer = "";
        const answer = async (text: string, id: string) => {
          lastAnswer = text;
          await projector.handleNotification({
            method: "item/completed",
            params: {
              threadId: "parent-thread",
              turnId: "parent-turn",
              item: { type: "agentMessage", id, phase: "final_answer", text },
            },
          });
        };
        runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
          await answer("NO_REPLY", "duplicate-answer");
          return { delivered: true, path: "steered" };
        });
        try {
          if (order === "terminal-first") {
            await client.notify(completedChild());
          }
          await client.notify(
            receipt === "contextual"
              ? nativeCompletionNotification({ result: "The build passed.", turnId: "parent-turn" })
              : deliveredNativeCompletion(),
          );
          await answer(final, "parent-answer");
          if (order === "native-first") {
            await client.notify(completedChild());
          }
          await projector.handleNotification({
            method: "turn/completed",
            params: {
              threadId: "parent-thread",
              turn: {
                id: "parent-turn",
                status: "completed",
                items: [{ type: "agentMessage", id: "last-answer", text: lastAnswer }],
                error: null,
              },
            },
          });
          await owner.unregister();
          expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([final]);
          expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        } finally {
          await owner.unregister();
          client.close();
        }
      },
    );

    it("defers delivery until unbound parent release and revokes admission on retirement", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const delivery = createDeferred<{ delivered: boolean; path: "direct" }>();
      runtime.deliverAgentHarnessCompletion.mockReturnValue(delivery.promise);
      client.request.mockImplementation(async (method) => {
        if (method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const owner = await registerRuntimeOwner(client, runtime);
      let retirement: Promise<void> | undefined;
      try {
        await notifyChildStarted(client);
        await client.notify(completedChild());
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        await owner.unregister();
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
          expect.objectContaining({ result: "The build passed." }),
        );
        const canAdmit =
          runtime.deliverAgentHarnessCompletion.mock.calls[0]?.[0].isSourceSessionAdmissionAllowed;
        expect(canAdmit?.()).toBe(true);
        retirement = codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
        expect(canAdmit?.()).toBe(false);
      } finally {
        delivery.resolve({ delivered: true, path: "direct" });
        await delivery.promise;
        await retirement;
        await owner.unregister();
        client.close();
      }
    });

    it("defers completion when turn/started races ahead of the turn/start response", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const owner = await registerParent(monitor);
      try {
        await client.notify(turnStartedNotification("parent-turn", { threadId: "parent-thread" }));
        await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
        await client.notify(completedChild());
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        await client.notify(deliveredNativeCompletion());
        owner.bindTurn("parent-turn");
        await owner.unregister();
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      } finally {
        await owner.unregister();
        client.close();
      }
    });

    it("retains a rotated parent's child subscription until its receipt write settles", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const writeStarted = createDeferred<void>();
      const releaseWrite = createDeferred<void>();
      const assignmentStore: CodexNativeSubagentAssignmentStore = {
        assertCurrent() {},
        read: () => [],
        record: async () => true,
        consume: async () => {
          writeStarted.resolve();
          await releaseWrite.promise;
          return true;
        },
      };
      const claimChildThread = vi.fn(async () => {});
      const releaseChildThread = vi.fn(async (threadId: string) => {
        await client.client.request("thread/unsubscribe", { threadId });
      });
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
        claimChildThread,
        releaseChildThread,
      });
      const parent = await monitor.registerParent({
        parentThreadId: "parent-thread",
        agentId: "main",
        requesterSessionKey: "agent:main:discord:channel:C123",
        completionScope: createCompletionScope(),
        historyOwner: nativeHistoryOwner(),
        assignmentStore,
      });
      const observer = await registerParent(
        monitor,
        "rotated-parent",
        undefined,
        nativeHistoryOwner("rotated-parent"),
      );
      let receipt: Promise<void> | undefined;
      let retirement: Promise<void> | undefined;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        parent.bindTurn("parent-turn");
        observer.bindTurn("observer-turn");
        await notifyChildStarted(client);
        await client.notify(turnStartedNotification("child-turn"));
        await client.notify(completedChild());
        expect(claimChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");
        receipt = client.notify(
          itemNotification({
            id: "rotated-wait-receipt",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "parent-thread",
            receiverThreadIds: ["child-thread"],
            agentsStates: {
              "child-thread": { status: "completed", message: "The build passed." },
            },
          }),
        );
        await writeStarted.promise;
        let retired = false;
        retirement = monitor.retireParent("rotated-parent").then(() => {
          retired = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(retired).toBe(false);
        expect(releaseChildThread).not.toHaveBeenCalled();
        expect(client.request).not.toHaveBeenCalledWith("thread/unsubscribe", expect.anything());
        releaseWrite.resolve();
        await Promise.all([receipt, retirement]);
        expect(releaseChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");
        expect(client.request).toHaveBeenCalledExactlyOnceWith("thread/unsubscribe", {
          threadId: "child-thread",
        });
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      } finally {
        releaseWrite.resolve();
        await Promise.allSettled([receipt, retirement]);
        await parent.unregister();
        await observer.unregister();
        await monitor.dispose();
        client.close();
        vi.useRealTimers();
      }
    });

    it.each(["other-turn", "quoted-fragment"])(
      "does not acknowledge a completion from %s",
      async (source) => {
        const client = createClient();
        const runtime = createRuntime();
        const owner = await registerRuntimeOwner(client, runtime);
        owner.bindTurn("parent-turn");
        await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
        const receipt = deliveredNativeCompletion();
        if (source === "other-turn") {
          receipt.params.turnId = "older-turn";
        } else {
          const part = receipt.params.item.content[0]!;
          part.text = `Example: ${part.text}`;
        }
        try {
          await client.notify(completedChild());
          await client.notify(receipt);
          expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
          await owner.unregister();
          expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
        } finally {
          await owner.unregister();
          client.close();
        }
      },
    );

    it("applies a native receipt immediately when active recovery learns its agent path", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
      });
      onTestFinished(() => monitor.dispose());
      const owner = await registerParent(monitor);
      owner.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(completedChild());
      await client.notify(turnStartedNotification("next-turn", { error: null }));
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
        successfulSendInputOutput({ callId: "followup", submissionId: "next-turn" }),
      );
      await client.notify(deliveredNativeCompletion());
      const history = threadRead({
        agentPath: "/root/worker",
        previousResult: "The build passed.",
        turnId: "next-turn",
        status: "inProgress",
        threadStatus: "active",
      });
      history.thread.turns![0]!.id = "child-turn";
      client.setThreadRead("child-thread", history);
      await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);
      await owner.unregister();
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    });

    it("does not carry an unmatched receipt into a later parent run", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const first = await registerParent(monitor);
      first.bindTurn("parent-turn");
      await notifyChildStarted(client, "parent-thread", "waiting-child");
      await client.notify(deliveredNativeCompletion());
      await first.unregister();
      const second = await registerParent(monitor);
      second.bindTurn("next-turn");
      await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
      await client.notify(completedChild());
      await second.unregister();
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
      client.close();
    });

    it("delivers a deferred completion if the parent client closes", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const delivered = createDeferred<void>();
      runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
        delivered.resolve();
        return { delivered: true, path: "direct" };
      });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const owner = await registerParent(monitor);
      owner.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(completedChild());
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      client.close();
      await delivered.promise;
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
      await owner.unregister();
    });
  });
});

describe("native follow-up receipt custody", () => {
  it("retains an accepted submission until its native completion is delivered", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const recorded = createDeferred<void>();
    const consumed = createDeferred<void>();
    const store = {
      assertCurrent() {},
      read: () => [],
      record: vi.fn(async () => {
        recorded.resolve();
        return true;
      }),
      consume: vi.fn(async () => {
        consumed.resolve();
        return true;
      }),
    };
    const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
      recoveryPollDelaysMs: [],
    });
    onTestFinished(() => monitor.dispose());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      completionScope: createCompletionScope(),
      submissionStore: store,
    });
    owner.bindTurn("parent-turn");
    await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
    await client.notify(turnStartedNotification("child-turn", { error: null }));
    await client.notify(completedChild("child-turn", "The build passed.", "first-result"));
    await client.notify(deliveredNativeCompletion());
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
      successfulSendInputOutput({ callId: "followup", submissionId: "next-turn" }),
    );
    await recorded.promise;
    await client.notify(turnStartedNotification("next-turn", { error: null }));
    expect(store.consume).not.toHaveBeenCalled();
    await client.notify(completedChild("next-turn", "Follow-up complete.", "next-result"));
    expect(store.consume).not.toHaveBeenCalled();
    await owner.unregister();
    await consumed.promise;
    expect(store.consume).toHaveBeenCalledOnce();
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ result: "Follow-up complete." }),
    );
  });
});
