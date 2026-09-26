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
  deliveredNativeCompletion,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
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
        const parent = await registerParent(monitor);
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
        await parent.unregister();
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
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
        const owner = await codexNativeSubagentMonitorRuntime.register({
          client: client.client,
          parentThreadId: "parent-thread",
          requesterSessionKey: "agent:main:discord:channel:C123",
          completionScope: createCompletionScope(),
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
        runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
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
      ensureCodexAppServerClientRuntime(client as never, { agentDir: "/tmp/agent" });
      const owner = await codexNativeSubagentMonitorRuntime.register({
        client: client as never,
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        completionScope: createCompletionScope(),
        agentId: "main",
        runtime,
      });
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
      const owner = await codexNativeSubagentMonitorRuntime.register({
        client: client.client,
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        completionScope: createCompletionScope(),
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
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
        await owner.unregister();
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
      } finally {
        await owner.unregister();
        client.close();
      }
    });

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
    await client.notify(
      childTurnCompletedNotification({
        status: "completed",
        turnId: "child-turn",
        items: [
          {
            type: "agentMessage",
            id: "first-result",
            phase: "final_answer",
            text: "The build passed.",
          },
        ],
      }),
    );
    await client.notify(deliveredNativeCompletion());
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
    await recorded.promise;
    await client.notify(turnStartedNotification("next-turn", { error: null }));
    expect(store.consume).not.toHaveBeenCalled();
    await client.notify(
      childTurnCompletedNotification({
        status: "completed",
        turnId: "next-turn",
        items: [
          {
            type: "agentMessage",
            id: "next-result",
            phase: "final_answer",
            text: "Follow-up complete.",
          },
        ],
      }),
    );
    expect(store.consume).not.toHaveBeenCalled();
    await owner.unregister();
    await consumed.promise;
    expect(store.consume).toHaveBeenCalledOnce();
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ result: "Follow-up complete." }),
    );
  });
});
