import { setImmediate } from "node:timers/promises";
import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  childTurnCompletedNotification,
  CodexNativeSubagentMonitor,
  createClient,
  createRecordedRuntime,
  createTaskScope,
  notifyChildStarted,
  successfulSendInputOutput,
  taskRecord,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import type {
  CodexNativeSubagentSubmission,
  CodexNativeSubagentSubmissionStore,
} from "./native-subagent-submission.js";

const initialRunId = "codex-thread:child-thread";
const followupRunId = "codex-thread:child-thread:turn:turn-b";
type Client = ReturnType<typeof createClient>;

async function startTurn(client: Client, id: string) {
  await client.notify(turnStartedNotification(id, { error: null }));
}

async function completeTurn(client: Client, id: string, text: string) {
  await client.notify(
    childTurnCompletedNotification({
      turnId: id,
      status: "completed",
      items: [{ type: "agentMessage", id: `message-${id}`, phase: "final_answer", text }],
    }),
  );
}

async function collabCall(client: Client, tool: "wait" | "sendInput", id: string) {
  for (const phase of ["started", "completed"] as const) {
    await client.notify({
      method: `item/${phase}`,
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          type: "collabAgentToolCall",
          id,
          tool,
          status: phase === "started" ? "inProgress" : "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates:
            phase === "started"
              ? {}
              : {
                  "child-thread":
                    tool === "wait"
                      ? { status: "completed", message: "A result" }
                      : { status: "running" },
                },
        },
      },
    });
  }
}

async function deliverInitialResult(client: Client) {
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
            text: '<subagent_notification>\n{"agent_path":"child-thread","status":{"completed":"A result"}}\n</subagent_notification>',
          },
        ],
      },
    },
  });
  await collabCall(client, "wait", "wait-a");
}

async function submitFollowup(client: Client, submissionId = "turn-b") {
  await collabCall(client, "sendInput", "send-b");
  await client.notify(successfulSendInputOutput({ callId: "send-b", submissionId }));
}

function createFixture(
  records = new Map<string, AgentHarnessTaskRecord>(),
  submissionStore?: CodexNativeSubagentSubmissionStore,
  historyOwner?: CodexNativeSubagentHistoryOwner,
) {
  const client = createClient();
  const runtime = createRecordedRuntime(records);
  let connected = true;
  const heldClients = new Set<symbol>();
  const heldThreads = new Set<symbol>();
  const retain = (holds: Set<symbol>) => {
    const token = Symbol("native-subagent-retention");
    holds.add(token);
    return () => {
      holds.delete(token);
    };
  };
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    recoveryPollDelaysMs: [10],
    retainClient: () => retain(heldClients),
    retainParentThread: () => retain(heldThreads),
    hasObservationBacking: (parentThreadId, childThreadId) =>
      connected && parentThreadId === "parent-thread" && childThreadId === "child-thread",
  });
  let resolveHistory!: (value: ReturnType<typeof threadRead>) => void;
  const historyGate = new Promise<ReturnType<typeof threadRead>>((resolve) => {
    resolveHistory = resolve;
  });
  client.setThreadReadFactory("child-thread", () => historyGate);
  let history = threadRead({ turnId: "turn-b", result: "B result" });
  history.thread.turns!.unshift(
    ...threadRead({ turnId: "turn-a", result: "A result" }).thread.turns!,
  );
  const releaseHistory = (nextHistory = history) => {
    history = nextHistory;
    client.setThreadRead("child-thread", history);
    resolveHistory(history);
  };
  const owner = monitor.registerParent({
    parentThreadId: "parent-thread",
    requesterSessionKey: "agent:main:discord:channel:C123",
    taskRuntimeScope: createTaskScope(),
    agentId: "main",
    submissionStore,
    historyOwner,
  });
  owner.bindTurn("parent-turn");
  return {
    client,
    runtime,
    monitor,
    owner,
    records,
    heldClients,
    heldThreads,
    releaseHistory,
    dropObservationBacking: () => {
      connected = false;
    },
    close: async () => {
      releaseHistory();
      await owner.unregister();
      connected = false;
      monitor.dispose();
    },
  };
}

describe("Codex native transient predecessor anchor", () => {
  it.each([
    "child-lifecycle-first",
    "parent-output-first",
    "parent-output-before-a-end",
    "parent-unregister-before-anchor",
  ] as const)("preserves the accepted follow-up when %s", async (order) => {
    const records = new Map<string, AgentHarnessTaskRecord>();
    const receipts = new Map<string, CodexNativeSubagentSubmission>();
    const ownerStatesAtRecord: boolean[] = [];
    const tasksAtConsume: Array<AgentHarnessTaskRecord | undefined> = [];
    let parentRegistered = true;
    const submissionStore = {
      assertCurrent: () => {},
      read: () => [...receipts.values()],
      record: vi.fn<CodexNativeSubagentSubmissionStore["record"]>(async (receipt, guard) => {
        guard();
        ownerStatesAtRecord.push(parentRegistered);
        receipts.set(receipt.callId, structuredClone(receipt));
        return true;
      }),
      consume: vi.fn<CodexNativeSubagentSubmissionStore["consume"]>(async (receipt, guard) => {
        guard();
        tasksAtConsume.push(structuredClone(records.get(followupRunId)));
        return receipts.delete(receipt.callId);
      }),
    } satisfies CodexNativeSubagentSubmissionStore;
    const fixture = createFixture(
      records,
      order === "parent-unregister-before-anchor" ? submissionStore : undefined,
    );
    const { client, runtime, monitor, owner } = fixture;
    try {
      await notifyChildStarted(client);
      expect(records.size).toBe(1);
      const startObservedBeforeOutput =
        order === "child-lifecycle-first" || order === "parent-output-before-a-end";
      if (startObservedBeforeOutput) {
        await startTurn(client, "turn-a");
      }
      if (order === "child-lifecycle-first") {
        await completeTurn(client, "turn-a", "A result");
      }
      if (order !== "parent-output-before-a-end") {
        await deliverInitialResult(client);
      }
      await submitFollowup(client);
      expect(records.get(followupRunId)).toBeUndefined();
      if (order === "parent-unregister-before-anchor") {
        await owner.unregister();
        parentRegistered = false;
      }
      if (order !== "child-lifecycle-first") {
        if (!startObservedBeforeOutput) {
          await startTurn(client, "turn-a");
        }
        await completeTurn(client, "turn-a", "A result");
      }
      if (order === "parent-output-before-a-end") {
        await deliverInitialResult(client);
      }
      if (order === "parent-unregister-before-anchor") {
        expect(submissionStore.record).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            callId: "send-b",
            predecessorNativeTurnId: "turn-a",
            submissionId: "turn-b",
          }),
          expect.any(Function),
        );
        expect(ownerStatesAtRecord).toEqual([false]);
      }
      const completedA = structuredClone(records.get(initialRunId));
      expect(completedA).toMatchObject({
        status: "succeeded",
        deliveryStatus: "delivered",
        terminalSummary: "A result",
        detail: { nativeTurnId: "turn-a" },
      });
      await startTurn(client, "turn-b");
      await completeTurn(client, "turn-b", "B result");
      fixture.releaseHistory();
      await monitor.reconcileChildThread("child-thread");
      await owner.unregister();
      await setImmediate();

      expect(records.get(initialRunId)).toEqual(completedA);
      expect(records.get(followupRunId)).toMatchObject({
        status: "succeeded",
        deliveryStatus: "delivered",
        terminalSummary: "B result",
        detail: { nativeTurnId: "turn-b" },
      });
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ childSessionKey: followupRunId, result: "B result" }),
      );
      if (order === "parent-unregister-before-anchor") {
        expect(submissionStore.consume).toHaveBeenCalledOnce();
        expect(tasksAtConsume).toEqual([expect.objectContaining({ runId: followupRunId })]);
        expect(receipts.size).toBe(0);
      }
    } finally {
      await fixture.close();
    }
  });

  it("persists an admitted held receipt after detached observation loses its backing", async () => {
    const records = new Map<string, AgentHarnessTaskRecord>();
    const receipts = new Map<string, CodexNativeSubagentSubmission>();
    const recordEntered = createDeferred<void>();
    const releaseRecord = createDeferred<void>();
    let recordCompletion: Promise<boolean> | undefined;
    const submissionStore = {
      assertCurrent: () => {},
      read: () => [...receipts.values()],
      record: vi.fn<CodexNativeSubagentSubmissionStore["record"]>((receipt, guard) => {
        recordCompletion = (async () => {
          recordEntered.resolve();
          await releaseRecord.promise;
          guard();
          receipts.set(receipt.callId, structuredClone(receipt));
          return true;
        })();
        return recordCompletion;
      }),
      consume: vi.fn<CodexNativeSubagentSubmissionStore["consume"]>(async () => false),
    } satisfies CodexNativeSubagentSubmissionStore;
    const fixture = createFixture(records, submissionStore);
    const { client, monitor, owner } = fixture;
    try {
      await notifyChildStarted(client);
      await deliverInitialResult(client);
      await submitFollowup(client);
      await owner.unregister();
      await startTurn(client, "turn-a");
      await completeTurn(client, "turn-a", "A result");
      await recordEntered.promise;
      const completedA = structuredClone(records.get(initialRunId));
      expect(completedA).toMatchObject({
        status: "succeeded",
        deliveryStatus: "delivered",
        detail: { nativeTurnId: "turn-a" },
      });

      fixture.dropObservationBacking();
      fixture.releaseHistory();
      await monitor.reconcileChildThread("child-thread");
      await setImmediate();
      expect(receipts.size).toBe(0);
      expect(fixture.heldClients.size).toBe(0);
      expect(fixture.heldThreads.size).toBe(0);

      releaseRecord.resolve();
      await expect(recordCompletion).resolves.toBe(true);
      await setImmediate();
      expect([...receipts.values()]).toEqual([
        {
          parentTurnId: "parent-turn",
          callId: "send-b",
          childThreadId: "child-thread",
          submissionId: "turn-b",
          predecessorRunId: initialRunId,
          predecessorNativeTurnId: "turn-a",
        },
      ]);
      expect([...records.values()]).toEqual([completedA]);
      expect(submissionStore.consume).not.toHaveBeenCalled();
      expect(fixture.heldClients.size).toBe(0);
      expect(fixture.heldThreads.size).toBe(0);
    } finally {
      releaseRecord.resolve();
      await recordCompletion?.catch(() => undefined);
      await fixture.close();
    }
  });

  it("creates no extra task or retained observation for an opaque steer after A catches up", async () => {
    const fixture = createFixture();
    const { client, owner, records, runtime } = fixture;
    try {
      await notifyChildStarted(client);
      await submitFollowup(client, "opaque-steer-submission");
      await startTurn(client, "turn-a");
      await completeTurn(client, "turn-a", "A result");
      await deliverInitialResult(client);
      fixture.releaseHistory(threadRead({ turnId: "turn-a", result: "A result" }));
      await owner.unregister();
      await setImmediate();

      expect([...records.values()]).toEqual([
        expect.objectContaining({
          runId: initialRunId,
          status: "succeeded",
          deliveryStatus: "delivered",
          detail: expect.objectContaining({ nativeTurnId: "turn-a" }),
        }),
      ]);
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      expect(fixture.heldClients.size).toBe(0);
      expect(fixture.heldThreads.size).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it.each(["running", "succeeded"] as const)(
    "does not invent a predecessor anchor for a %s legacy row from copied history or the submitted turn",
    async (status) => {
      const historyOwner = {
        parentThreadId: "parent-thread",
        sessionId: "session-1",
        connectionFingerprint: "a".repeat(64),
      };
      const legacyA: AgentHarnessTaskRecord = {
        ...taskRecord({
          childThreadId: "child-thread",
          status,
          deliveryStatus: status === "succeeded" ? "delivered" : "not_applicable",
          ...(status === "succeeded" ? { endedAt: 1 } : {}),
        }),
        ...(status === "succeeded" ? { terminalSummary: "A result" } : {}),
        detail: {
          nativeHistory: historyOwner,
        },
      };
      const snapshot = structuredClone(legacyA);
      const fixture = createFixture(new Map([[initialRunId, legacyA]]), undefined, historyOwner);
      const { client, monitor, owner, records, runtime } = fixture;
      try {
        await notifyChildStarted(client);
        await startTurn(client, "turn-b");
        await completeTurn(client, "turn-b", "B result");
        await submitFollowup(client);
        fixture.releaseHistory();
        await monitor.reconcileChildThread("child-thread");
        await owner.unregister();
        await setImmediate();

        expect([...records.values()]).toEqual([snapshot]);
        expect(records.get(followupRunId)).toBeUndefined();
        expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    },
  );
});
