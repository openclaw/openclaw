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
  type CodexThreadReadResponse,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createTaskScope,
  registerParent,
  notifyChildStarted,
  successfulSendInputOutput,
  nativeCompletionNotification,
  nativeHistoryOwner,
  deliveredNativeCompletion,
  parentSampled,
  nativeWaitOutput,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
  taskRecord,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";

function contextualNativeCompletion(agentPath = "child-thread", result = "The build passed.") {
  return {
    method: "rawResponseItem/completed",
    params: {
      threadId: "parent-thread",
      turnId: "parent-turn",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `<subagent_notification>\n${JSON.stringify({ agent_path: agentPath, status: { completed: result } })}\n</subagent_notification>`,
          },
        ],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["multi_agent.subagent_notification"],
        },
      },
    },
  } satisfies CodexServerNotification;
}

describe("CodexNativeSubagentMonitor", () => {
  describe("native completion delivery ownership", () => {
    registerCodexEventProjectorTestLifecycle();

    it.each(
      (["completed", "errored", "shutdown"] as const).flatMap((childStatus) =>
        (["wait-first", "terminal-first"] as const).map((order) => ({ childStatus, order })),
      ),
    )(
      "does not repeat a $childStatus child result returned by native wait ($order)",
      async ({ order, childStatus }) => {
        const client = createClient();
        const runtime = createRuntime();
        const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
        const parent = registerParent(monitor);
        parent.bindTurn("parent-turn");
        await notifyChildStarted(client);
        const terminal = () =>
          client.notify(
            childStatus === "shutdown"
              ? nativeCompletionNotification({ statusLabel: "shutdown", turnId: "parent-turn" })
              : childTurnCompletedNotification({
                  status: childStatus === "completed" ? "completed" : "failed",
                  ...(childStatus === "errored" ? { error: "child result" } : {}),
                  items: [
                    {
                      type: "agentMessage",
                      id: "final",
                      phase: "final_answer",
                      text: "child result",
                    },
                  ],
                }),
          );
        if (order === "terminal-first") {
          await terminal();
        }
        await client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              type: "collabAgentToolCall",
              id: "wait-call",
              tool: "wait",
              status: childStatus === "errored" ? "failed" : "completed",
              senderThreadId: "parent-thread",
              receiverThreadIds: ["child-thread"],
              agentsStates: {
                "child-thread": {
                  status: childStatus,
                  message: childStatus === "shutdown" ? null : "child result",
                },
              },
            },
          },
        });
        if (order === "wait-first") {
          await terminal();
        }
        await client.notify(nativeWaitOutput("wait-call"));
        await client.notify(parentSampled());
        await parent.unregister();
        await vi.waitFor(() => {
          expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
            expect.objectContaining({
              runId: "codex-thread:child-thread",
              deliveryStatus: "delivered",
            }),
          );
        });
        expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
        monitor.dispose();
      },
    );

    const completedChild = () =>
      childTurnCompletedNotification({
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "child-final",
            phase: "final_answer",
            text: "The build passed.",
          },
        ],
      });

    it.each(
      ["agent-message", "contextual"].flatMap((receipt) => [
        { receipt, order: "native-first", final: "The build passed. The change is ready." },
        { receipt, order: "terminal-first", final: "The build passed. The change is ready." },
        { receipt, order: "native-first", final: "NO_REPLY" },
      ]),
    )(
      "preserves $final when $receipt delivery and child completion arrive $order",
      async ({ receipt, order, final }) => {
        const client = createClient();
        const runtime = createRuntime();
        ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/agent" });
        const owner = codexNativeSubagentMonitorRuntime.register({
          client: client.client,
          parentThreadId: "parent-thread",
          requesterSessionKey: "agent:main:discord:channel:C123",
          taskRuntimeScope: createTaskScope(),
          agentId: "main",
          runtime,
        });
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
        runtime.deliverAgentHarnessTaskCompletion.mockImplementation(async () => {
          await answer("NO_REPLY", "duplicate-answer");
          return { delivered: true, path: "steered" };
        });
        try {
          if (order === "terminal-first") {
            await client.notify(completedChild());
          }
          await client.notify(
            receipt === "contextual" ? contextualNativeCompletion() : deliveredNativeCompletion(),
          );
          await answer(final, "parent-answer");
          await client.notify(parentSampled());
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
          expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
          expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith({
            runId: "codex-thread:child-thread",
            deliveryStatus: "delivered",
          });
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
      runtime.deliverAgentHarnessTaskCompletion.mockReturnValue(delivery.promise);
      client.request.mockImplementation(async (method) => {
        if (method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`unexpected request: ${method}`);
      });
      ensureCodexAppServerClientRuntime(client as never, { agentDir: "/tmp/agent" });
      const owner = codexNativeSubagentMonitorRuntime.register({
        client: client as never,
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        taskRuntimeScope: createTaskScope(),
        agentId: "main",
        runtime,
      });
      try {
        await notifyChildStarted(client);
        await client.notify(completedChild());
        expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
        await owner.unregister();
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
          expect.objectContaining({ result: "The build passed." }),
        );
        const canAdmit =
          runtime.deliverAgentHarnessTaskCompletion.mock.calls[0]?.[0]
            .isSourceSessionAdmissionAllowed;
        expect(canAdmit?.()).toBe(true);
        codexNativeSubagentMonitorRuntime.retireParent(client as never, "parent-thread");
        expect(canAdmit?.()).toBe(false);
      } finally {
        delivery.resolve({ delivered: true, path: "direct" });
        await delivery.promise;
        await owner.unregister();
        client.close();
      }
    });

    it("defers completion when turn/started races ahead of the turn/start response", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const owner = registerParent(monitor);
      try {
        await client.notify(turnStartedNotification("parent-turn", { threadId: "parent-thread" }));
        await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
        await client.notify(completedChild());
        expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
        await client.notify(deliveredNativeCompletion());
        await client.notify(parentSampled());
        owner.bindTurn("parent-turn");
        await owner.unregister();
        expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
        expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith({
          runId: "codex-thread:child-thread",
          deliveryStatus: "delivered",
        });
      } finally {
        await owner.unregister();
        client.close();
      }
    });

    it.each(
      ["agent-message", "contextual"].flatMap((kind) =>
        [
          "other-turn",
          "other-parent",
          "other-child",
          "ordinary-message",
          "user-text",
          "different-result",
          "quoted-fragment",
        ].map((source) => ({ kind, source })),
      ),
    )("does not acknowledge a $kind completion from $source", async ({ kind, source }) => {
      const client = createClient();
      const runtime = createRuntime();
      ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/agent" });
      const owner = codexNativeSubagentMonitorRuntime.register({
        client: client.client,
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        taskRuntimeScope: createTaskScope(),
        agentId: "main",
        runtime,
      });
      owner.bindTurn("parent-turn");
      await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
      const receipt =
        kind === "contextual"
          ? contextualNativeCompletion(
              source === "other-child" ? "other-child" : "child-thread",
              source === "different-result" ? "Unrelated result." : "The build passed.",
            )
          : deliveredNativeCompletion();
      const params = receipt.params as JsonObject;
      const item = params.item as JsonObject;
      if (source === "other-turn") {
        params.turnId = "older-turn";
      } else if (source === "other-parent") {
        params.threadId = "another-parent";
      } else if (source === "other-child" && kind === "agent-message") {
        item.author = "/root/another-child";
        item.content = [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/another-child\nPayload:\nThe build passed.",
          },
        ];
      } else if (source === "ordinary-message") {
        item.content = [{ type: "input_text", text: "Still working on the build." }];
      } else if (source === "user-text") {
        item.type = "message";
        item.role = "user";
        item.internal_chat_message_metadata_passthrough = { content_item_kinds: ["user.text"] };
      } else if (source === "different-result" && kind === "agent-message") {
        item.content = [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nUnrelated result.",
          },
        ];
      } else if (source === "quoted-fragment") {
        const part = receipt.params.item.content[0]!;
        part.text = `Example: ${part.text}`;
      }
      try {
        await client.notify(completedChild());
        await client.notify(receipt);
        await client.notify(parentSampled());
        expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
        await owner.unregister();
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
      } finally {
        await owner.unregister();
        client.close();
      }
    });

    it.each(["before", "after"])(
      "retains a native receipt when task recovery finishes %s parent release",
      async (order) => {
        const client = createClient();
        let releaseRead!: (response: CodexThreadReadResponse) => void;
        client.setThreadReadFactory(
          "child-thread",
          () =>
            new Promise((resolve) => {
              releaseRead = resolve;
            }),
        );
        const runtime = createRuntime();
        const historyOwner = nativeHistoryOwner();
        runtime.listTaskRecords.mockReturnValue([
          taskRecord({ historyOwner, childThreadId: "child-thread" }),
        ]);
        const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
        const owner = registerParent(monitor, undefined, undefined, historyOwner);
        owner.bindTurn("parent-turn");
        expect(client.request).toHaveBeenCalledOnce();
        await client.notify(deliveredNativeCompletion());
        await client.notify(parentSampled());
        if (order === "after") {
          await owner.unregister();
        }
        releaseRead(threadRead({ agentPath: "/root/worker", result: "The build passed." }));
        await vi.waitFor(() => expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledOnce());
        await owner.unregister();
        expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
        expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith({
          runId: "codex-thread:child-thread",
          deliveryStatus: "delivered",
        });
        client.close();
      },
    );

    it.each(["known-child", "pending-registration"] as const)(
      "applies a new parent's late-alias receipt to retained recovery (%s)",
      async (source) => {
        const client = createClient();
        let releaseRead!: (response: CodexThreadReadResponse) => void;
        client.setThreadReadFactory(
          "child-thread",
          () =>
            new Promise((resolve) => {
              releaseRead = resolve;
            }),
        );
        const runtime = createRuntime();
        const historyOwner = nativeHistoryOwner();
        const task = taskRecord({ historyOwner, childThreadId: "child-thread" });
        if (source === "pending-registration") {
          runtime.listTaskRecords.mockReturnValue([task]);
        }
        const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
          recoveryPollDelaysMs: [],
        });
        onTestFinished(() => monitor.dispose());
        const first = registerParent(monitor, undefined, undefined, historyOwner);
        first.bindTurn("parent-turn");
        if (source === "known-child") {
          await notifyChildStarted(client);
        }
        await first.unregister();
        runtime.listTaskRecords.mockReturnValue([task]);
        const second = registerParent(monitor, undefined, undefined, historyOwner);
        second.bindTurn("new-parent-turn");
        try {
          const receipt = deliveredNativeCompletion();
          (receipt.params as JsonObject).turnId = "new-parent-turn";
          await client.notify(receipt);
          await client.notify(parentSampled("new-parent-turn"));
          const history = threadRead({ agentPath: "/root/worker", result: "The build passed." });
          client.setThreadRead("child-thread", history);
          releaseRead(history);
          await vi.waitFor(() => expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledOnce());
          await second.unregister();
          expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
          expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith({
            runId: task.runId,
            deliveryStatus: "delivered",
          });
        } finally {
          await second.unregister();
        }
      },
    );

    it("keeps restored lineage and retained recovery on one receipt owner", async () => {
      const client = createClient();
      let releaseRead!: (response: CodexThreadReadResponse) => void;
      client.setThreadReadFactory(
        "child-thread",
        () =>
          new Promise((resolve) => {
            releaseRead = resolve;
          }),
      );
      const runtime = createRuntime();
      const nativeHistory = {
        parentThreadId: "parent-thread",
        sessionId: "parent-session",
        connectionFingerprint: "a".repeat(64),
      };
      runtime.listTaskRecords.mockReturnValue([
        {
          ...taskRecord({ childThreadId: "child-thread:turn:turn-1" }),
          createdAt: 2,
          detail: { nativeHistory, nativeTurnId: "turn-1" },
        },
        {
          ...taskRecord({
            childThreadId: "child-thread",
            status: "succeeded",
            deliveryStatus: "delivered",
          }),
          createdAt: 1,
          terminalSummary: "Prior result.",
          detail: { nativeHistory, nativeTurnId: "turn-previous" },
        },
      ]);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
      });
      onTestFinished(() => monitor.dispose());
      const registration = {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        taskRuntimeScope: createTaskScope(),
        agentId: "main",
        historyOwner: nativeHistory,
      };
      const first = monitor.registerParent(registration);
      await first.unregister();
      const second = monitor.registerParent(registration);
      second.bindTurn("new-parent-turn");
      const history = threadRead({ previousResult: "Prior result.", result: "The build passed." });
      client.setThreadRead("child-thread", history);
      releaseRead(history);
      await vi.waitFor(() => expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledOnce());
      const receipt = deliveredNativeCompletion();
      (receipt.params as JsonObject).turnId = "new-parent-turn";
      await client.notify(receipt);
      await client.notify(parentSampled("new-parent-turn"));
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "new-parent-turn",
          item: {
            type: "subAgentActivity",
            id: "queue-only-message",
            kind: "interacted",
            agentThreadId: "child-thread",
            agentPath: "/root/worker",
          },
        },
      });
      await second.unregister();
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith({
        runId: "codex-thread:child-thread:turn:turn-1",
        deliveryStatus: "delivered",
      });
    });

    it.each(
      (["stored", "legacy-predecessor", "history", "metadata"] as const).flatMap((lineage) =>
        [false, true].map((sameTime) => ({ lineage, sameTime })),
      ),
    )(
      "restores unresolved predecessors before successor receipts with $lineage lineage (same-time=$sameTime)",
      async ({ lineage, sameTime }) => {
        const client = createClient();
        const runtime = createRuntime();
        const nativeHistory = {
          parentThreadId: "parent-thread",
          sessionId: "parent-session",
          connectionFingerprint: "a".repeat(64),
        };
        const first = {
          ...taskRecord({ childThreadId: "child-thread" }),
          createdAt: 1,
          detail: {
            ...(lineage === "stored" ? { nativeHistory } : {}),
            nativeTurnId: "turn-previous",
          },
        };
        const second = {
          ...taskRecord({
            childThreadId: "child-thread:turn:turn-1",
            status: "succeeded",
            deliveryStatus: "pending",
          }),
          createdAt: sameTime ? 1 : 2,
          terminalSummary: "The build passed.",
          detail: {
            ...(lineage === "stored" || lineage === "legacy-predecessor" ? { nativeHistory } : {}),
            nativeTurnId: "turn-1",
          },
        };
        runtime.listTaskRecords.mockReturnValue([second, first]);
        const history = threadRead({
          agentPath: "/root/worker",
          previousResult: "The build passed.",
          result: "The build passed.",
        });
        const metadata = structuredClone(history);
        metadata.thread.turns = [];
        let releaseRead!: () => void;
        const readGate = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        let firstFullRead = true;
        client.setThreadReadFactory("child-thread", async (params) => {
          if (params.includeTurns === false) {
            return metadata;
          }
          await readGate;
          if (firstFullRead) {
            firstFullRead = false;
            if (lineage === "metadata") {
              throw new Error("history is not materialized");
            }
          }
          return history;
        });
        const claimDirectChild = vi.fn(() => vi.fn());
        const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
          recoveryPollDelaysMs: [],
        });
        onTestFinished(() => monitor.dispose());
        const owner = monitor.registerParent({
          parentThreadId: "parent-thread",
          requesterSessionKey: first.requesterSessionKey,
          taskRuntimeScope: createTaskScope(first.requesterSessionKey),
          historyOwner: nativeHistory,
          claimDirectChild,
        });
        owner.bindTurn("parent-turn");
        try {
          expect(client.request).toHaveBeenCalledOnce();
          const receipt = deliveredNativeCompletion();
          if (lineage === "stored" || lineage === "legacy-predecessor") {
            const item = (receipt.params as JsonObject).item as JsonObject;
            item.author = "child-thread";
            item.content = [
              {
                type: "input_text",
                text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: child-thread\nPayload:\nThe build passed.",
              },
            ];
          }
          await client.notify(receipt);
          await client.notify(parentSampled());
          releaseRead();
          if (lineage === "history" || lineage === "metadata") {
            await owner.unregister();
            expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
            expect(runtime.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalled();
            expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
            expect(claimDirectChild).not.toHaveBeenCalled();
            return;
          }
          await vi.waitFor(() =>
            expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(
              lineage === "stored" ? 2 : 1,
            ),
          );
          if (lineage === "legacy-predecessor") {
            expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalledWith(
              expect.objectContaining({ runId: first.runId }),
            );
          }
          expect(runtime.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalledWith({
            runId: second.runId,
            deliveryStatus: "delivered",
          });
          await owner.unregister();
          await vi.waitFor(() =>
            expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                childSessionKey: second.runId,
                result: "The build passed.",
              }),
            ),
          );
          expect(claimDirectChild).not.toHaveBeenCalled();
        } finally {
          releaseRead();
          await owner.unregister();
        }
      },
    );

    it("applies a recovered agent path to predecessor receipts before admitting a successor", async () => {
      const client = createClient();
      let releaseRead!: (response: CodexThreadReadResponse) => void;
      client.setThreadReadFactory(
        "child-thread",
        () =>
          new Promise((resolve) => {
            releaseRead = resolve;
          }),
      );
      const runtime = createRuntime();
      const nativeHistory = {
        parentThreadId: "parent-thread",
        sessionId: "parent-session",
        connectionFingerprint: "a".repeat(64),
      };
      runtime.listTaskRecords.mockReturnValue([
        {
          ...taskRecord({
            childThreadId: "child-thread",
            status: "succeeded",
            deliveryStatus: "pending",
          }),
          createdAt: 1,
          terminalSummary: "The build passed.",
          detail: { nativeHistory, nativeTurnId: "turn-previous" },
        },
        {
          ...taskRecord({ childThreadId: "child-thread:turn:turn-1", status: "running" }),
          createdAt: 2,
          detail: { nativeHistory, nativeTurnId: "turn-1" },
        },
      ]);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      onTestFinished(() => monitor.dispose());
      const owner = monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        taskRuntimeScope: createTaskScope(),
        agentId: "main",
        historyOwner: nativeHistory,
      });
      owner.bindTurn("parent-turn");
      await client.notify(deliveredNativeCompletion());
      await client.notify(parentSampled());
      const history = threadRead({
        agentPath: "/root/worker",
        previousResult: "The build passed.",
        status: "inProgress",
        threadStatus: "active",
      });
      client.setThreadRead("child-thread", history);
      releaseRead(history);
      await vi.waitFor(() => expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledOnce());
      await owner.unregister();
      client.setThreadRead(
        "child-thread",
        threadRead({
          agentPath: "/root/worker",
          previousResult: "The build passed.",
          result: "Follow-up result.",
        }),
      );
      await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(true);
      await vi.waitFor(() =>
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ result: "Follow-up result." }),
        ),
      );
    });

    it.each(["other-turn", "other-lineage"])(
      "does not acknowledge recovered delivery from %s",
      async (source) => {
        const client = createClient();
        let releaseRead!: (response: CodexThreadReadResponse) => void;
        client.setThreadReadFactory(
          "child-thread",
          () =>
            new Promise((resolve) => {
              releaseRead = resolve;
            }),
        );
        const runtime = createRuntime();
        const historyOwner = {
          parentThreadId: "parent-thread",
          sessionId: "parent-session",
          lifecycleRevision: "parent-lifecycle",
          connectionFingerprint: "a".repeat(64),
        };
        const task = {
          ...taskRecord({ childThreadId: "child-thread" }),
          detail: {
            nativeHistory: {
              ...historyOwner,
              parentThreadId: source === "other-lineage" ? "old-parent" : "parent-thread",
            },
          },
        };
        runtime.listTaskRecords.mockReturnValue([task]);
        const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
        const owner = monitor.registerParent({
          parentThreadId: "parent-thread",
          requesterSessionKey: task.requesterSessionKey,
          taskRuntimeScope: createTaskScope(task.requesterSessionKey),
          agentId: "main",
          historyOwner,
        });
        owner.bindTurn("parent-turn");
        const receipt = deliveredNativeCompletion();
        if (source === "other-turn") {
          (receipt.params as JsonObject).turnId = "old-turn";
        }
        await client.notify(receipt);
        await client.notify(parentSampled());
        await owner.unregister();
        releaseRead(
          threadRead({
            agentPath: "/root/worker",
            parentThreadId: source === "other-lineage" ? "old-parent" : "parent-thread",
            result: "The build passed.",
          }),
        );
        await vi.waitFor(() =>
          expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce(),
        );
        client.close();
      },
    );

    it("applies a sampled native receipt when active recovery learns its agent path", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
      });
      onTestFinished(() => monitor.dispose());
      const owner = registerParent(monitor);
      owner.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(completedChild());
      await client.notify(turnStartedNotification("next-turn", { error: null }));
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
        successfulSendInputOutput({ callId: "followup", submissionId: "next-turn" }),
      );
      await client.notify(deliveredNativeCompletion());
      await client.notify(parentSampled());
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
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith({
        runId: "codex-thread:child-thread",
        deliveryStatus: "delivered",
      });
    });

    it("does not carry an unmatched receipt into a later parent run", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const first = registerParent(monitor);
      first.bindTurn("parent-turn");
      await notifyChildStarted(client, "parent-thread", "waiting-child");
      await client.notify(deliveredNativeCompletion());
      await client.notify(parentSampled());
      await first.unregister();
      const second = registerParent(monitor);
      second.bindTurn("next-turn");
      await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
      await client.notify(completedChild());
      await second.unregister();
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
      client.close();
    });

    it("delivers a deferred completion if the parent client closes", async () => {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const owner = registerParent(monitor);
      owner.bindTurn("parent-turn");
      await notifyChildStarted(client);
      await client.notify(completedChild());
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      client.close();
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
      await owner.unregister();
    });
  });
});
