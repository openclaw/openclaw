import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  notifyChildStarted,
  registerParent,
  successfulSendInputOutput,
  turnStartedNotification,
  childTurnCompletedNotification,
  deliveredNativeCompletion,
  observeCompletionAttempts,
  itemNotification,
  collabItem,
  agentMessage,
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
  await client.notify(
    childTurnCompletedNotification({
      threadId,
      turnId,
      status,
      items: [
        { type: "agentMessage", id: `result-${turnId}`, phase: "final_answer", text: turnId },
      ],
    }),
  );
}

async function waitItem(client: Client, phase: "started" | "completed", receivers: string[]) {
  await client.notify(
    itemNotification(
      collabItem("wait", receivers, {
        id: "wait-item",
        senderThreadId: "waiter",
        status: phase === "started" ? "inProgress" : "completed",
      }),
      "waiter-turn",
      "waiter",
      phase,
    ),
  );
}
async function acceptFollowup(client: Client, parentThreadId = "parent-thread") {
  await client.notify(
    itemNotification(
      collabItem("sendInput", ["receiver"], { id: "submit-b", senderThreadId: parentThreadId }),
      "parent-turn",
      parentThreadId,
    ),
  );
  await client.notify(
    successfulSendInputOutput({ parentThreadId, callId: "submit-b", submissionId: "turn-b" }),
  );
}

async function awaitingAdmission(
  options: {
    previousStatus?: "completed" | "interrupted";
    receiverParent?: string;
    receivers?: string[];
    laterPendingTurn?: boolean;
  } = {},
) {
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
    return monitor.dispose();
  });
  (await registerParent(monitor)).bindTurn("parent-turn");
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
  return { client, events, receiverParent };
}

describe("native wait assignment projection", () => {
  it.each([
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

  it("retains approval attention while refreshing the underlying receiver dependency", async () => {
    const { client, events } = await awaitingAdmission();
    await client.notify({
      method: "thread/status/changed",
      params: {
        threadId: "waiter",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    });
    const attentionEventCount = events.length;
    await acceptFollowup(client);
    expect(events).toHaveLength(attentionEventCount);
    expect(events.at(-1)?.data.wait).toEqual({
      kind: "approval",
    });
    await client.notify({
      method: "thread/status/changed",
      params: { threadId: "waiter", status: { type: "active", activeFlags: [] } },
    });
    expect(events.at(-1)?.data.wait).toMatchObject({
      kind: "children",
      dependencies: [{ runId: "codex-thread:receiver:turn:turn-b" }],
    });
  });

  it.each(["ended-turn", "foreign-parent"])(
    "does not refresh an ineligible wait: %s",
    async (scenario) => {
      const { client, events, receiverParent } = await awaitingAdmission(
        scenario === "foreign-parent" ? { receiverParent: "foreign-parent" } : {},
      );
      if (scenario === "ended-turn") {
        await endTurn(client, "waiter", "waiter-turn", "interrupted");
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

it.each([
  { status: "completed", bound: true, olderSettled: false },
  { status: "interrupted", bound: false, olderSettled: false },
  { status: "completed", bound: true, olderSettled: true },
] as const)(
  "consumes native receipts with parent $status, bound=$bound, older settled=$olderSettled",
  async ({ status, bound, olderSettled }) => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
      recoveryPollDelaysMs: [],
    });
    const attempts = observeCompletionAttempts();
    const older = olderSettled ? await registerParent(monitor) : undefined;
    const parent = await registerParent(monitor);
    try {
      if (older) {
        older.bindTurn("older-turn");
      }
      if (bound) {
        parent.bindTurn("parent-turn");
      } else {
        await client.notify(turnStartedNotification("parent-turn", { threadId: "parent-thread" }));
      }
      const parentEnd = (turnId: string) =>
        client.notify(
          childTurnCompletedNotification({
            threadId: "parent-thread",
            turnId,
            status,
          }),
        );
      if (older) {
        await parentEnd("older-turn");
      }
      await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
      if (!older) {
        await parentEnd("parent-turn");
      }
      await client.notify(deliveredNativeCompletion());
      const completion = childTurnCompletedNotification({
        status: "completed",
        items: [agentMessage("child-final", "The build passed.", "final_answer")],
      });
      await client.notify(completion);
      if (!bound) {
        parent.bindTurn("parent-turn");
      }
      await parent.unregister();
      await older?.unregister();
      if (!older) {
        await client.notify(completion);
      }
      await attempts.settle();
      if (older) {
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      } else {
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            childSessionId: "child-thread",
            result: "The build passed.",
            status: "succeeded",
          }),
        );
      }
    } finally {
      await parent.unregister();
      await older?.unregister();
      await attempts.settle();
      await monitor.dispose();
    }
  },
);
