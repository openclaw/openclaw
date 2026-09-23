import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  childTurnCompletedNotification,
  createClient,
  createRecordedRuntime,
  createTaskScope,
  notifyChildStarted,
  parentSampled,
  nativeWaitOutput,
  registerCodexNativeSubagentMonitor,
  successfulSendInputOutput,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentSubmissionStore } from "./native-subagent-submission.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

afterEach(() => vi.useRealTimers());

async function createSubmissionFixture() {
  const identity = { kind: "session" as const, agentId: "main", sessionId: "parent-session" };
  const binding = {
    threadId: "parent-thread",
    cwd: "/workspace",
    appServerRuntimeFingerprint: "runtime",
  };
  const bindingStore = createCodexTestBindingStore();
  await bindingStore.mutate(identity, { kind: "set", binding });
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: identity.sessionId,
    binding,
  });
  if (!owner) {
    throw new Error("The binding must provide a history owner.");
  }
  const client = createClient();
  client.setThreadRead("child-thread", threadRead({ turnId: "turn-a", result: "result A" }));
  ensureCodexAppServerClientRuntime(client as never, { agentDir: "/workspace/agent" });
  const unsubscribe = vi.fn(async (_threadId: string) => undefined);
  for (const id of [binding.threadId, "child-thread"]) {
    await retainCodexAppServerLiveThread(client as never, id, unsubscribe);
  }
  const records = new Map<string, AgentHarnessTaskRecord>();
  const runtime = createRecordedRuntime(records, "agent:main:main");
  const holds = { client: 0, parent: 0, child: 0 };
  const consume = vi.fn<CodexNativeSubagentSubmissionStore["consume"]>((receipt, guard) =>
    bindingStore.mutate(
      identity,
      { kind: "consume-native-subagent-submission", owner, receipt },
      guard,
    ),
  );
  const submissionStore: CodexNativeSubagentSubmissionStore = {
    assertCurrent: () => {
      const current = bindingStore.read(identity);
      if (!current || !matchesCodexNativeSubagentSubmissionBinding(current, owner)) {
        throw new Error("Submission binding changed.");
      }
    },
    read: () => bindingStore.readNativeSubagentSubmissions(identity, owner),
    record: (receipt, guard) =>
      bindingStore.mutate(
        identity,
        { kind: "record-native-subagent-submission", owner, receipt },
        guard,
      ),
    consume,
  };
  const parent = registerCodexNativeSubagentMonitor({
    client: client as never,
    parentThreadId: binding.threadId,
    requesterSessionKey: "agent:main:main",
    taskRuntimeScope: createTaskScope("agent:main:main"),
    historyOwner: owner,
    submissionStore,
    runtime,
    retainClient: () => {
      holds.client += 1;
      return () => {
        holds.client -= 1;
      };
    },
    retainParentThread: (id) => {
      const key = id === binding.threadId ? "parent" : "child";
      const release = protectCodexAppServerLiveThread(client as never, id);
      holds[key] += 1;
      return () => {
        holds[key] -= 1;
        release();
      };
    },
  });
  onTestFinished(async () => {
    client.close();
    await parent.unregister();
  });
  parent.bindTurn("parent-turn-a");
  await notifyChildStarted(client);
  await client.notify(turnStartedNotification("turn-a"));
  await client.notify(
    childTurnCompletedNotification({
      turnId: "turn-a",
      status: "completed",
      items: [{ id: "a", type: "agentMessage", text: "result A" }],
    }),
  );
  await client.notify({
    method: "item/completed",
    params: {
      threadId: binding.threadId,
      turnId: "parent-turn-a",
      item: {
        type: "collabAgentToolCall",
        id: "wait-a",
        tool: "wait",
        status: "completed",
        senderThreadId: binding.threadId,
        receiverThreadIds: ["child-thread"],
        agentsStates: { "child-thread": { status: "completed", message: "result A" } },
      },
    },
  });
  await client.notify(nativeWaitOutput("wait-a", "parent-turn-a"));
  await client.notify(parentSampled("parent-turn-a"));
  await vi.waitFor(() =>
    expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(false),
  );
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  expect(records.size).toBe(1);
  const initial = structuredClone(records.get("codex-thread:child-thread"));
  runtime.deliverAgentHarnessTaskCompletion.mockClear();

  const submit = async (submissionId: string) => {
    parent.bindTurn("parent-turn-b");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: binding.threadId,
        turnId: "parent-turn-b",
        item: {
          id: "send-b",
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          senderThreadId: binding.threadId,
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "running" } },
        },
      },
    });
    await client.notify(
      successfulSendInputOutput({
        parentThreadId: binding.threadId,
        turnId: "parent-turn-b",
        callId: "send-b",
        submissionId,
      }),
    );
    await parent.unregister();
    expect(submissionStore.read()).toHaveLength(1);
    expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  };
  return {
    client,
    parent,
    records,
    runtime,
    holds,
    consume,
    submissionStore,
    unsubscribe,
    submit,
    initial,
  };
}

it("stops observing opaque receipts when existing warm subscriptions expire", async () => {
  const fixture = await createSubmissionFixture();
  const { client, records, runtime, holds, consume, submissionStore, unsubscribe } = fixture;
  vi.useFakeTimers({ shouldClearNativeTimers: true });
  await fixture.submit("815dc55d-2d19-4bfe-9fd3-038ce4d6aada");
  const receipt = structuredClone(submissionStore.read());
  const reads = () =>
    client.request.mock.calls.filter(([method]) => method === "thread/read").length;
  // The existing client-runtime owner expires unprotected subscriptions after 30 minutes.
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(hasCodexAppServerLiveThread(client as never, "parent-thread")).toBe(false);
  expect(hasCodexAppServerLiveThread(client as never, "child-thread")).toBe(false);
  expect(unsubscribe.mock.calls.map(([id]) => id).toSorted()).toEqual([
    "child-thread",
    "parent-thread",
  ]);
  const readsAtExpiry = reads();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reads()).toBe(readsAtExpiry);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reads()).toBe(readsAtExpiry);
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  expect(submissionStore.read()).toEqual(receipt);
  expect(records.size).toBe(1);
  expect(records.get("codex-thread:child-thread")).toEqual(fixture.initial);
  expect(consume).not.toHaveBeenCalled();
  expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
  await client.notify(turnStartedNotification(receipt[0]!.submissionId));
  expect(records.size).toBe(1);
  expect(records.get("codex-thread:child-thread")).toEqual(fixture.initial);
  expect(submissionStore.read()).toEqual(receipt);
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
});

it("admits a delayed exact start under warm backing and preserves the active task's holds", async () => {
  const fixture = await createSubmissionFixture();
  const { client, records, runtime, holds, submissionStore } = fixture;
  await releaseCodexAppServerLiveThread(client as never, "parent-thread");
  expect(hasCodexAppServerLiveThread(client as never, "child-thread")).toBe(true);
  await fixture.submit("turn-b");
  await client.notify(turnStartedNotification("turn-b"));
  const runId = "codex-thread:child-thread:turn:turn-b";
  await vi.waitFor(() => expect(submissionStore.read()).toEqual([]));
  expect(records.size).toBe(2);
  expect(records.get(runId)).toMatchObject({ status: "running" });
  expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true);
  expect(holds.client).toBe(1);
  expect(holds.parent).toBe(1);
  await expect(releaseCodexAppServerLiveThread(client as never, "child-thread")).resolves.toBe(
    false,
  );
  expect(records.get(runId)).toMatchObject({ status: "running" });
  await client.notify(
    childTurnCompletedNotification({
      turnId: "turn-b",
      status: "completed",
      items: [{ id: "b", type: "agentMessage", text: "result B" }],
    }),
  );
  await vi.waitFor(() =>
    expect(records.get(runId)).toMatchObject({ status: "succeeded", deliveryStatus: "delivered" }),
  );
  expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
  expect(records.get("codex-thread:child-thread")).toEqual(fixture.initial);
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
});
