import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, onTestFinished } from "vitest";
import {
  createClient,
  createMonitorFixture,
  notifyChildStarted,
  registerParent,
  deliveredNativeCompletion,
  observeCompletionAttempts,
  collabItem,
  agentMessage,
} from "./native-subagent-monitor.test-support.js";

type Client = ReturnType<typeof createClient>;

async function startTurn(client: Client, threadId: string, turnId: string) {
  await client.startTurn(turnId, { threadId, error: null });
}

async function endTurn(
  client: Client,
  threadId: string,
  turnId: string,
  status: "completed" | "interrupted" = "completed",
) {
  await client.completeTurn({
    threadId,
    turnId,
    status,
    items: [agentMessage(`result-${turnId}`, turnId, "final_answer")],
  });
}

async function waitItem(client: Client, phase: "started" | "completed", receivers: string[]) {
  await client.item(
    collabItem("wait", receivers, {
      id: "wait-item",
      senderThreadId: "waiter",
      status: phase === "started" ? "inProgress" : "completed",
    }),
    "waiter-turn",
    "waiter",
    phase,
  );
}
async function acceptFollowup(client: Client, parentThreadId = "parent-thread") {
  await client.item(
    collabItem("sendInput", ["receiver"], { id: "submit-b", senderThreadId: parentThreadId }),
    "parent-turn",
    parentThreadId,
  );
  await client.sendInputOutput({
    parentThreadId,
    callId: "submit-b",
    submissionId: "turn-b",
  });
}

async function awaitingAdmission(
  options: {
    previousStatus?: "completed" | "interrupted";
    receiverParent?: string;
    receivers?: string[];
    laterPendingTurn?: boolean;
  } = {},
) {
  const { client, monitor } = createMonitorFixture();
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

it.each([
  ["interrupted", false],
  ["completed", true],
] as const)(
  "projects %s admission with later pending turn %s",
  async (previousStatus, laterPendingTurn) => {
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

it("retains approval attention while refreshing receiver dependencies", async () => {
  const { client, events } = await awaitingAdmission();
  const approval = (activeFlags: string[]) =>
    client.notify({
      method: "thread/status/changed",
      params: {
        threadId: "waiter",
        status: { type: "active", activeFlags },
      },
    });
  await approval(["waitingOnApproval"]);
  const attentionEventCount = events.length;
  await acceptFollowup(client);
  expect(events).toHaveLength(attentionEventCount);
  expect(events.at(-1)?.data.wait).toEqual({ kind: "approval" });
  await approval([]);
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

it("preserves receiver order, detail cap, and original pending count", async () => {
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

it.each([
  ["completed", true, false],
  ["interrupted", false, false],
  ["completed", true, true],
] as const)(
  "consumes native receipts with parent %s, bound=%s, older settled=%s",
  async (status, bound, olderSettled) => {
    const { client, runtime, monitor } = createMonitorFixture({ recoveryPollDelaysMs: [] });
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
        await client.startTurn("parent-turn", { threadId: "parent-thread" });
      }
      const parentEnd = (turnId: string) =>
        client.completeTurn({
          threadId: "parent-thread",
          turnId,
          status,
        });
      if (older) {
        await parentEnd("older-turn");
      }
      await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
      if (!older) {
        await parentEnd("parent-turn");
      }
      await client.notify(deliveredNativeCompletion());
      const completeChild = () =>
        client.finishTurn(
          "child-turn",
          agentMessage("child-final", "The build passed.", "final_answer"),
        );
      await completeChild();
      if (!bound) {
        parent.bindTurn("parent-turn");
      }
      await parent.unregister();
      await older?.unregister();
      if (!older) {
        await completeChild();
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
