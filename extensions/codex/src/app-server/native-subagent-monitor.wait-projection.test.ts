import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  nativeHistoryOwner,
  notifyChildStarted,
  registerParent,
  successfulSendInputOutput,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";

type Client = ReturnType<typeof createClient>;

async function startTurn(client: Client, threadId: string, turnId: string) {
  await client.notify(turnStartedNotification(turnId, { threadId, error: null }));
}

async function endTurn(
  client: Client,
  threadId: string,
  turnId: string,
  status: "completed" | "interrupted" = "completed",
) {
  await client.notify({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status,
        items: [
          { type: "agentMessage", id: `result-${turnId}`, phase: "final_answer", text: turnId },
        ],
        error: null,
      },
    },
  });
}

async function waitItem(client: Client, phase: "started" | "completed", receivers: string[]) {
  await client.notify({
    method: `item/${phase}`,
    params: {
      threadId: "waiter",
      turnId: "waiter-turn",
      item: {
        type: "collabAgentToolCall",
        id: "wait-item",
        tool: "wait",
        senderThreadId: "waiter",
        receiverThreadIds: receivers,
        status: phase === "started" ? "inProgress" : "completed",
      },
    },
  });
}

async function acceptFollowup(client: Client, parentThreadId = "parent-thread") {
  await client.notify({
    method: "item/completed",
    params: {
      threadId: parentThreadId,
      turnId: "parent-turn",
      item: {
        type: "collabAgentToolCall",
        id: "submit-b",
        tool: "sendInput",
        status: "completed",
        senderThreadId: parentThreadId,
        receiverThreadIds: ["receiver"],
      },
    },
  });
  await client.notify(
    successfulSendInputOutput({ parentThreadId, callId: "submit-b", submissionId: "turn-b" }),
  );
}

async function createFixture(historyOwner?: ReturnType<typeof nativeHistoryOwner>) {
  const client = createClient();
  const runtime = createRuntime();
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime);
  const events: Parameters<Parameters<typeof onAgentEvent>[0]>[0][] = [];
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId === "codex-thread:waiter" && event.stream === "execution") {
      events.push(event);
    }
  });
  onTestFinished(() => {
    unsubscribe();
    monitor.dispose();
  });
  (await registerParent(monitor, undefined, undefined, historyOwner)).bindTurn("parent-turn");
  return { client, runtime, monitor, events };
}

async function awaitingAdmission(
  options: {
    previousStatus?: "completed" | "interrupted";
    receiverParent?: string;
    receivers?: string[];
    laterPendingTurn?: boolean;
  } = {},
) {
  const fixture = await createFixture();
  const { client, monitor } = fixture;
  const receiverParent = options.receiverParent ?? "parent-thread";
  if (receiverParent !== "parent-thread") {
    (await registerParent(monitor, receiverParent, "agent:main:foreign")).bindTurn("parent-turn");
  }
  await notifyChildStarted(client, receiverParent, "receiver");
  await startTurn(client, "receiver", "turn-a");
  await endTurn(client, "receiver", "turn-a", options.previousStatus);
  await notifyChildStarted(client, "parent-thread", "waiter");
  await startTurn(client, "waiter", "waiter-turn");
  await startTurn(client, "receiver", "turn-b");
  if (options.laterPendingTurn) {
    await endTurn(client, "receiver", "turn-b");
    await startTurn(client, "receiver", "turn-c");
  }
  await waitItem(client, "started", options.receivers ?? ["receiver"]);
  return { ...fixture, receiverParent };
}

describe("native wait assignment projection", () => {
  it.each([
    { previousStatus: "completed", laterPendingTurn: false },
    { previousStatus: "interrupted", laterPendingTurn: false },
    { previousStatus: "completed", laterPendingTurn: true },
  ] as const)(
    "tracks admission after $previousStatus with later pending turn $laterPendingTurn without settling its wait",
    async ({ previousStatus, laterPendingTurn }) => {
      const { client, events } = await awaitingAdmission({
        previousStatus,
        laterPendingTurn,
      });
      const beforeAdmission = events.at(-1);
      expect(beforeAdmission?.data).toMatchObject({
        state: "waiting",
        executionId: "waiter-turn",
        wait: {
          kind: "children",
          dependencies: [{ runId: "codex-thread:receiver" }],
          pendingCount: 1,
        },
      });
      await acceptFollowup(client);
      const runId =
        previousStatus === "completed"
          ? "codex-thread:receiver:turn:turn-b"
          : "codex-thread:receiver";
      expect(events.at(-1)?.data).toMatchObject({
        state: "waiting",
        sourceId: beforeAdmission?.data.sourceId,
        executionId: "waiter-turn",
        wait: { kind: "children", dependencies: [{ runId }], pendingCount: 1 },
      });
      expect(beforeAdmission?.data.wait).toMatchObject({
        dependencies: [{ runId: "codex-thread:receiver" }],
      });
      const admittedEventCount = events.length;
      await endTurn(client, "receiver", "turn-b");
      expect(events).toHaveLength(admittedEventCount);

      await waitItem(client, "completed", ["receiver"]);
      expect(events.at(-1)?.data).toMatchObject({ state: "running", executionId: "waiter-turn" });
      expect(events.at(-1)?.data.wait).toBeUndefined();
    },
  );

  it.each(["waitingOnApproval", "waitingOnUserInput"])(
    "retains %s while refreshing the underlying receiver dependency",
    async (flag) => {
      const { client, events } = await awaitingAdmission();
      await client.notify({
        method: "thread/status/changed",
        params: { threadId: "waiter", status: { type: "active", activeFlags: [flag] } },
      });
      const attentionEventCount = events.length;
      await acceptFollowup(client);
      expect(events).toHaveLength(attentionEventCount);
      expect(events.at(-1)?.data.wait).toEqual({
        kind: flag === "waitingOnApproval" ? "approval" : "user_input",
      });
      await client.notify({
        method: "thread/status/changed",
        params: { threadId: "waiter", status: { type: "active", activeFlags: [] } },
      });
      expect(events.at(-1)?.data.wait).toMatchObject({
        kind: "children",
        dependencies: [{ runId: "codex-thread:receiver:turn:turn-b" }],
      });
    },
  );

  it.each(["completed-wait", "ended-turn", "retired-parent", "foreign-parent", "mailbox"])(
    "does not refresh an ineligible wait: %s",
    async (scenario) => {
      const { client, monitor, events, receiverParent } = await awaitingAdmission({
        ...(scenario === "foreign-parent" ? { receiverParent: "foreign-parent" } : {}),
        ...(scenario === "mailbox" ? { receivers: [] } : {}),
      });
      if (scenario === "completed-wait") {
        await waitItem(client, "completed", ["receiver"]);
      } else if (scenario === "ended-turn") {
        await endTurn(client, "waiter", "waiter-turn", "interrupted");
      } else if (scenario === "retired-parent") {
        monitor.retireParent("parent-thread");
      }
      const eventCount = events.length;
      await acceptFollowup(client, receiverParent);
      expect(events).toHaveLength(eventCount);
    },
  );

  it("preserves observed receiver order, the detail cap, and the original pending count", async () => {
    const receivers = [
      "unknown",
      "receiver",
      ...Array.from({ length: 33 }, (_, i) => `receiver-${i}`),
    ];
    const { client, events } = await awaitingAdmission({
      receivers: [...receivers, " receiver ", ""],
    });
    await acceptFollowup(client);
    expect(events.at(-1)?.data.wait).toEqual({
      kind: "children",
      pendingCount: 35,
      dependencies: receivers.slice(0, 32).map((id) => ({
        runId: id === "receiver" ? "codex-thread:receiver:turn:turn-b" : `codex-thread:${id}`,
      })),
    });
  });
});
