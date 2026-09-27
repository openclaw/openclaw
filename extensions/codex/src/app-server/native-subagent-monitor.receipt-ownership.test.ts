import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { expect, it, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  createClient,
  createRecordedRuntime,
  createNativeModelSourceFixture,
  createTaskScope,
  nativeHistoryOwner,
  notifyChildStarted,
  successfulSendInputOutput,
  turnStartedNotification,
  threadRead,
  observeCompletionAttempts,
} from "./native-subagent-monitor.test-support.js";

it.each([
  "before-successor",
  "during-successor",
  "foreign-observer",
  "changed-observer-session",
  "changed-observer-lifecycle",
  "changed-observer-connection",
  "changed-delivery-owner",
  "replaced-task",
  "unrelated-result",
  "old-parent-push",
])("settles retained predecessor receipts through a rotated parent (%s)", async (scenario) => {
  const completions = observeCompletionAttempts();
  const client = createClient();
  const request = client.request.getMockImplementation()!;
  client.request.mockImplementation(async (method, params) =>
    method === "thread/unsubscribe" ? {} : request(method, params),
  );
  client.setThreadRead("child-thread", threadRead({ turnId: "turn-a", result: "A result" }));
  const records = new Map<string, AgentHarnessTaskRecord>();
  const runtime = createRecordedRuntime(records);
  const createTask = runtime.createRunningTaskRun.getMockImplementation()!;
  // Persisted task metadata must not alias a live registration's owner object.
  runtime.createRunningTaskRun.mockImplementation((params) => createTask(structuredClone(params)));
  runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
    delivered: false,
    path: "direct",
    recoveryPending: true,
  });
  ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/agent" });
  const initialHistory = nativeHistoryOwner();
  const observerHistory = nativeHistoryOwner("rotated-parent");
  const registration = {
    client: client.client,
    requesterSessionKey: "agent:main:discord:channel:C123",
    taskRuntimeScope: createTaskScope(),
    runtime,
  };
  const initial = await codexNativeSubagentMonitorRuntime.register({
    ...registration,
    parentThreadId: "parent-thread",
    historyOwner: initialHistory,
  });
  let observer: Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>> | undefined;
  let foreign: Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>> | undefined;
  const firstRunId = "codex-thread:child-thread";
  const secondRunId = "codex-thread:child-thread:turn:turn-b";
  const collab = (parentThreadId: string, tool: string, result?: string) =>
    client.notify({
      method: "item/completed",
      params: {
        threadId: parentThreadId,
        turnId: "observer-turn",
        item: {
          id: `${tool}-${parentThreadId}`,
          type: "collabAgentToolCall",
          tool,
          status: "completed",
          senderThreadId: parentThreadId,
          receiverThreadIds: ["child-thread"],
          agentsStates: {
            "child-thread": result
              ? { status: "completed", message: result }
              : { status: "running" },
          },
        },
      },
    });
  try {
    initial.bindTurn("initial-turn");
    const initialCompletion = completions.next(firstRunId);
    await notifyChildStarted(
      client,
      "parent-thread",
      "child-thread",
      scenario === "during-successor" ? "/root/worker" : "child-thread",
    );
    await client.notify(turnStartedNotification("turn-a"));
    await client.notify(
      childTurnCompletedNotification({
        turnId: "turn-a",
        status: "completed",
        items: [{ type: "agentMessage", id: "a-final", text: "A result" }],
      }),
    );
    await initialCompletion;
    await completions.settle();
    await initial.unregister();
    await completions.settle();
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
    expect(records.get(firstRunId)).toMatchObject({
      status: "succeeded",
      deliveryStatus: "pending",
      terminalSummary: "A result",
    });
    observer = await codexNativeSubagentMonitorRuntime.register({
      ...registration,
      parentThreadId: "rotated-parent",
      historyOwner: observerHistory,
      ...(scenario === "during-successor"
        ? {
            modelSource: createNativeModelSourceFixture(["model-b"]),
            configurationQualification: {
              assertCurrent: () => {},
              hasProvider: (provider: string) => provider === "provider-b",
            },
          }
        : {}),
    });
    observer.bindTurn("observer-turn");
    await collab("rotated-parent", "resumeAgent", "A result");
    const initialRecord = structuredClone(records.get(firstRunId)!);
    if (scenario === "before-successor") {
      const receipt = completions.next(firstRunId);
      await collab("rotated-parent", "wait", "A result");
      await receipt;
      await completions.settle();
      expect(records.get(firstRunId)?.deliveryStatus).toBe("delivered");
    }
    await collab("rotated-parent", "sendInput");
    await client.notify(
      successfulSendInputOutput({
        parentThreadId: "rotated-parent",
        turnId: "observer-turn",
        callId: "sendInput-rotated-parent",
        submissionId: "turn-b",
      }),
    );
    await client.notify(turnStartedNotification("turn-b"));
    let secondRecord = structuredClone(records.get(secondRunId)!);
    expect(secondRecord).toMatchObject({ status: "running", runId: secondRunId });
    if (scenario === "during-successor") {
      for (const [threadId, provider] of [
        ["parent-thread", "provider-a"],
        ["rotated-parent", "provider-b"],
      ] as const) {
        const response = threadRead({ childThreadId: threadId, threadStatus: "notLoaded" });
        response.thread.modelProvider = provider;
        client.setThreadRead(threadId, response);
      }
      const nativeWrite = vi.fn();
      await expect(
        codexNativeSubagentMonitorRuntime
          .prepareModelInput({
            client: client.client,
            threadId: "child-thread",
            turnId: "turn-b",
            itemId: "original-native-root",
            target: "/root",
            readQualification: () => undefined,
            assertCurrent: () => {},
          })
          .then(nativeWrite),
      ).rejects.toThrow("does not admit this model");
      expect(client.request).toHaveBeenCalledWith(
        "thread/read",
        { threadId: "parent-thread", includeTurns: false },
        expect.any(Object),
      );
      expect(nativeWrite).not.toHaveBeenCalled();
    }
    await completions.settle();
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
    let receiptParent = "rotated-parent";
    if (scenario === "old-parent-push") {
      const successorCompletion = completions.next(secondRunId);
      await client.notify(
        childTurnCompletedNotification({
          turnId: "turn-b",
          status: "completed",
          items: [{ type: "agentMessage", id: "b-final", text: "B result" }],
        }),
      );
      await successorCompletion;
      await completions.settle();
      secondRecord = structuredClone(records.get(secondRunId)!);
      expect(secondRecord).toMatchObject({ status: "succeeded", deliveryStatus: "pending" });
      foreign = await codexNativeSubagentMonitorRuntime.register({
        ...registration,
        parentThreadId: "parent-thread",
        historyOwner: initialHistory,
      });
      foreign.bindTurn("parent-turn");
      await client.notify({
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
                text: '<subagent_notification>{"agent_path":"child-thread","status":{"completed":"B result"}}</subagent_notification>',
              },
            ],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["multi_agent.subagent_notification"],
            },
          },
        },
      });
    } else if (scenario === "foreign-observer") {
      receiptParent = "foreign-parent";
      foreign = await codexNativeSubagentMonitorRuntime.register({
        ...registration,
        parentThreadId: receiptParent,
        requesterSessionKey: "agent:other:main",
        taskRuntimeScope: createTaskScope("agent:other:main"),
        historyOwner: nativeHistoryOwner(receiptParent),
      });
      foreign.bindTurn("observer-turn");
    } else if (scenario === "changed-observer-session") {
      observerHistory.sessionId = "other-physical-session";
    } else if (scenario === "changed-observer-lifecycle") {
      observerHistory.lifecycleRevision = "other-lifecycle";
    } else if (scenario === "changed-observer-connection") {
      observerHistory.connectionFingerprint = "b".repeat(64);
    } else if (scenario === "changed-delivery-owner") {
      initialHistory.sessionId = "replacement-delivery-session";
    } else if (scenario === "replaced-task") {
      records.set(firstRunId, { ...initialRecord, taskId: "replacement-task" });
    }
    if (scenario !== "before-successor" && scenario !== "old-parent-push") {
      await collab(
        receiptParent,
        "wait",
        scenario === "unrelated-result" ? "Other result" : "A result",
      );
    }
    await completions.settle();
    const accepted = scenario === "before-successor" || scenario === "during-successor";
    expect(records.get(firstRunId)?.deliveryStatus).toBe(accepted ? "delivered" : "pending");
    expect(records.get(firstRunId)).toMatchObject({
      runId: firstRunId,
      status: "succeeded",
      terminalSummary: "A result",
      detail: initialRecord.detail,
    });
    expect(records.get(secondRunId)).toEqual(secondRecord);
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
  } finally {
    await Promise.all([
      codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread"),
      codexNativeSubagentMonitorRuntime.retireParent(client.client, "rotated-parent"),
    ]);
    await foreign?.unregister();
    await observer?.unregister();
    await initial.unregister();
    client.close();
    await completions.settle();
  }
});
