import { expect, it } from "vitest";
import {
  childTurnCompletedNotification,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  deliveredNativeCompletion,
  notifyChildStarted,
  observeCompletionAttempts,
  registerParent,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";

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

it.each([
  { status: "completed", bound: true },
  { status: "failed", bound: true },
  { status: "interrupted", bound: true },
  { status: "interrupted", bound: false },
] as const)(
  "delivers child completion queued after its parent is $status, bound=$bound",
  async ({ status, bound }) => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    const attempts = observeCompletionAttempts();
    const parent = await registerParent(monitor);
    try {
      if (bound) {
        parent.bindTurn("parent-turn");
      } else {
        await client.notify(turnStartedNotification("parent-turn", { threadId: "parent-thread" }));
      }
      await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
      await client.notify(
        childTurnCompletedNotification({
          threadId: "parent-thread",
          turnId: "parent-turn",
          status,
        }),
      );
      await client.notify(deliveredNativeCompletion());
      const childCompletion = completedChild();
      await client.notify(childCompletion);
      if (!bound) {
        parent.bindTurn("parent-turn");
      }
      await parent.unregister();
      await client.notify(childCompletion);
      await attempts.settle();

      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          childSessionId: "child-thread",
          result: "The build passed.",
          status: "succeeded",
        }),
      );
    } finally {
      await parent.unregister();
      await attempts.settle();
      await monitor.dispose();
    }
  },
);

it("still consumes foreground receipts when an older parent owner has settled", async () => {
  const client = createClient();
  const runtime = createRuntime();
  const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
    recoveryPollDelaysMs: [],
  });
  const attempts = observeCompletionAttempts();
  const older = await registerParent(monitor);
  const parent = await registerParent(monitor);
  try {
    older.bindTurn("older-turn");
    parent.bindTurn("parent-turn");
    await client.notify(
      childTurnCompletedNotification({
        threadId: "parent-thread",
        turnId: "older-turn",
        status: "completed",
      }),
    );
    await notifyChildStarted(client, "parent-thread", "child-thread", "/root/worker");
    await client.notify(deliveredNativeCompletion());
    await client.notify(completedChild());
    await parent.unregister();
    await older.unregister();
    await attempts.settle();

    expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  } finally {
    await parent.unregister();
    await older.unregister();
    await attempts.settle();
    await monitor.dispose();
  }
});
