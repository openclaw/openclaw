import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
} from "./client-runtime.js";
import {
  CodexNativeSubagentMonitor,
  childTurnCompletedNotification,
  createClient,
  createRuntime,
  createRecordedRuntime,
  registerCodexNativeSubagentMonitor,
  nativeCompletionNotification,
  successfulSendInputOutput,
  parentSampled,
  nativeWaitOutput,
  createTaskScope,
  deliveredNativeCompletion,
  notifyChildStarted,
  registerParent,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification } from "./protocol.js";

describe("native completion sampling", () => {
  it("retains completed-open children in the bounded owner and reclaims them for follow-up", async () => {
    const client = createClient();
    const runtime = createRecordedRuntime(new Map());
    const claimChildThread = vi.fn(async () => undefined);
    const retainChildThread = vi.fn(async () => true);
    const retainParentThread = vi.fn((_threadId: string) => vi.fn());
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      claimChildThread,
      retainChildThread,
      retainParentThread,
    });
    onTestFinished(() => monitor.dispose());
    registerParent(monitor).bindTurn("parent-turn");

    await notifyChildStarted(client);
    await client.notify({
      method: "turn/started",
      params: {
        threadId: "child-thread",
        turn: { id: "child-turn", status: "inProgress", items: [], error: null },
      },
    });
    await client.notify(nativeCompletionNotification({ turnId: "parent-turn" }));
    await client.notify(parentSampled());

    expect(claimChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");
    expect(retainChildThread).toHaveBeenCalledExactlyOnceWith("child-thread");

    await client.notify({
      method: "item/started",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          type: "collabAgentToolCall",
          id: "followup-input",
          tool: "sendInput",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
        },
      },
    });

    expect(claimChildThread).toHaveBeenCalledOnce();
    await client.notify({
      method: "turn/started",
      params: {
        threadId: "child-thread",
        turn: { id: "followup-turn", status: "inProgress", items: [], error: null },
      },
    });

    expect(claimChildThread).toHaveBeenCalledOnce();
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          type: "collabAgentToolCall",
          id: "followup-input",
          tool: "sendInput",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
        },
      },
    });
    await client.notify(
      successfulSendInputOutput({ callId: "followup-input", submissionId: "followup-turn" }),
    );

    expect(claimChildThread).toHaveBeenCalledTimes(2);
    const pins = retainParentThread.mock.results.map((result, index) => {
      if (result.type !== "return") {
        throw new Error("Parent retention failed.");
      }
      return { threadId: retainParentThread.mock.calls[index]?.[0], release: result.value };
    });
    expect(
      pins.filter((pin) => pin.release.mock.calls.length === 0).map((pin) => pin.threadId),
    ).toEqual(["parent-thread"]);
    for (const pin of pins.filter((candidate) => candidate.release.mock.calls.length > 0)) {
      expect(pin.release).toHaveBeenCalledOnce();
    }
    monitor.dispose();
    for (const pin of pins) {
      expect(pin.release).toHaveBeenCalledOnce();
    }
  });

  it.each(["producing-response", "recorded-output", "other-output", "sampled-output"])(
    "does not let a native wait sample its own result through %s",
    async (order) => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const owner = monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        taskRuntimeScope: createTaskScope(),
      });
      owner.bindTurn("parent-turn");
      try {
        await notifyChildStarted(client);
        await client.notify(
          childTurnCompletedNotification({
            status: "completed",
            items: [
              {
                type: "agentMessage",
                id: "child-final",
                phase: "final_answer",
                text: "child result",
              },
            ],
          }),
        );
        await client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              type: "collabAgentToolCall",
              id: "wait-result",
              tool: "wait",
              status: "completed",
              senderThreadId: "parent-thread",
              receiverThreadIds: ["child-thread"],
              agentsStates: { "child-thread": { status: "completed", message: "child result" } },
            },
          },
        });
        await client.notify(parentSampled());
        expect(runtime.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalledWith(
          expect.objectContaining({ deliveryStatus: "delivered" }),
        );
        if (order !== "producing-response") {
          await client.notify(
            nativeWaitOutput(order === "other-output" ? "unrelated-call" : "wait-result"),
          );
        }
        if (order === "sampled-output" || order === "other-output") {
          await client.notify(parentSampled());
        }
        await owner.unregister();
        if (order === "sampled-output") {
          expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
          expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
            expect.objectContaining({ deliveryStatus: "delivered" }),
          );
        } else {
          expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ result: "child result" }),
          );
        }
      } finally {
        await owner.unregister();
        monitor.dispose();
      }
    },
  );

  it.each(
    [false, true].flatMap((completed) =>
      [false, true].flatMap((identical) =>
        [false, true].map((receiptBeforeReuse) => ({ completed, identical, receiptBeforeReuse })),
      ),
    ),
  )(
    "keeps a reused V1 child owned when its predecessor receipt is sampled (completed=$completed, identical=$identical, receiptBeforeReuse=$receiptBeforeReuse)",
    async ({ completed, identical, receiptBeforeReuse }) => {
      const client = createClient();
      const records = new Map<string, AgentHarnessTaskRecord>();
      const runtime = createRecordedRuntime(records);
      ensureCodexAppServerClientRuntime(client as never, { agentDir: "/tmp/agent" });
      const owner = registerCodexNativeSubagentMonitor({
        client: client as never,
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        taskRuntimeScope: createTaskScope(),
        runtime,
      });
      owner.bindTurn("parent-turn");
      const firstRun = "codex-thread:child-thread";
      const nextRun = `${firstRun}:turn:followup-turn`;
      const nextResult = identical ? "first result" : "follow-up result";
      try {
        await notifyChildStarted(client);
        await client.notify(
          childTurnCompletedNotification({
            turnId: "first-turn",
            status: "completed",
            items: [
              {
                type: "agentMessage",
                id: "first-final",
                phase: "final_answer",
                text: "first result",
              },
            ],
          }),
        );
        expect(records.get(firstRun)).toMatchObject({
          status: "succeeded",
          deliveryStatus: "pending",
        });
        const receipt = nativeCompletionNotification({
          turnId: "parent-turn",
          result: "first result",
        });
        if (receiptBeforeReuse) {
          await client.notify(receipt);
        }
        await client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              type: "collabAgentToolCall",
              id: "followup",
              tool: "sendInput",
              status: "completed",
              senderThreadId: "parent-thread",
              receiverThreadIds: ["child-thread"],
            },
          },
        });
        await client.notify(
          successfulSendInputOutput({ callId: "followup", submissionId: "followup-turn" }),
        );
        await client.notify({
          method: "turn/started",
          params: {
            threadId: "child-thread",
            turn: { id: "followup-turn", status: "inProgress", items: [], error: null },
          },
        });
        await vi.waitFor(() => expect(records.get(nextRun)?.status).toBe("running"));
        expect(records.get(firstRun)?.deliveryStatus).toBe("pending");
        await vi.waitFor(() =>
          expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true),
        );
        const completeFollowup = () =>
          client.notify(
            childTurnCompletedNotification({
              turnId: "followup-turn",
              status: "completed",
              items: [
                { type: "agentMessage", id: "next-final", phase: "final_answer", text: nextResult },
              ],
            }),
          );
        if (completed) {
          await completeFollowup();
        }
        if (!receiptBeforeReuse) {
          await client.notify(receipt);
        }
        expect(records.get(firstRun)?.deliveryStatus).toBe("pending");
        await client.notify(parentSampled());
        await vi.waitFor(() => expect(records.get(firstRun)?.deliveryStatus).toBe("delivered"));
        expect(records.get(nextRun)?.deliveryStatus).toBe(completed ? "pending" : "not_applicable");
        expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true);
        await expect(
          consumeCodexAppServerLiveThread(client as never, "child-thread"),
        ).resolves.toBeUndefined();
        if (!completed) {
          await completeFollowup();
        }
        await owner.unregister();
        await vi.waitFor(() =>
          expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ childSessionKey: nextRun, result: nextResult }),
          ),
        );
        expect(records.get(firstRun)).toMatchObject({
          terminalSummary: "first result",
          deliveryStatus: "delivered",
        });
        expect(records.get(nextRun)).toMatchObject({
          terminalSummary: nextResult,
          deliveryStatus: "delivered",
        });
        await vi.waitFor(() =>
          expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(false),
        );
      } finally {
        await owner.unregister();
        client.close();
      }
    },
  );

  it.each([
    "yield-after-receipt",
    "abort-after-receipt",
    "receipt-after-response",
    "compaction-response",
    "different-turn-response",
    "yielded-response",
  ])("preserves an unsampled completion through %s", async (order) => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    let yielded = false;
    const owner = monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
      isTurnYielded: () => yielded,
    });
    owner.bindTurn("parent-turn");
    await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
    try {
      if (order === "receipt-after-response") {
        await client.notify(parentSampled());
      }
      await client.notify(deliveredNativeCompletion());
      await client.notify(
        childTurnCompletedNotification({
          status: "completed",
          items: [
            {
              type: "agentMessage",
              id: "result",
              phase: "final_answer",
              text: "The build passed.",
            },
          ],
        }),
      );
      yielded = order === "yield-after-receipt" || order === "yielded-response";
      if (order === "compaction-response") {
        const params = {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: { type: "contextCompaction", id: "compact" },
        };
        await client.notify({ method: "item/started", params } as CodexServerNotification);
        await client.notify(parentSampled());
        await client.notify({ method: "item/completed", params } as CodexServerNotification);
      } else if (order === "different-turn-response") {
        await client.notify(parentSampled("unrelated-turn"));
      } else if (order === "yielded-response") {
        await client.notify(parentSampled());
      } else if (order === "abort-after-receipt") {
        await client.notify({
          method: "turn/completed",
          params: {
            threadId: "parent-thread",
            turn: { id: "parent-turn", status: "interrupted", items: [], error: null },
          },
        });
      }
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      await owner.unregister();
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ result: "The build passed." }),
      );
    } finally {
      await owner.unregister();
      monitor.dispose();
      client.close();
    }
  });

  it.each([false, true])("consumes a sampled receipt with pre-bind=%s", async (prebind) => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    const owner = monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });
    if (prebind) {
      await client.notify({
        method: "turn/started",
        params: {
          threadId: "parent-thread",
          turn: { id: "parent-turn", status: "inProgress", items: [], error: null },
        },
      });
    } else {
      owner.bindTurn("parent-turn");
    }
    await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
    try {
      await client.notify(deliveredNativeCompletion());
      await client.notify(parentSampled());
      owner.bindTurn("parent-turn");
      await client.notify(
        childTurnCompletedNotification({
          status: "completed",
          items: [
            {
              type: "agentMessage",
              id: "result",
              phase: "final_answer",
              text: "The build passed.",
            },
          ],
        }),
      );
      await owner.unregister();
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith({
        runId: "codex-thread:child-thread",
        deliveryStatus: "delivered",
      });
    } finally {
      await owner.unregister();
      monitor.dispose();
      client.close();
    }
  });
});
