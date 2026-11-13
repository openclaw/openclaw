import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import type { IMessagePayload } from "./monitor/types.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

let closeOpenClawStateDatabaseForTest: typeof import("openclaw/plugin-sdk/plugin-state-test-runtime").closeOpenClawStateDatabaseForTest;

const resolveApproval = vi.hoisted(() => vi.fn());

// mock-isolation: Keep Gateway approval resolution synthetic while exercising the real durable queue.
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolveApproval,
}));

vi.useRealTimers();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("replays approvals durably", { timeout: 30_000 }, async () => {
  await loadFreshIMessageReplyCacheForTest();
  const state = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
  closeOpenClawStateDatabaseForTest = state.closeOpenClawStateDatabaseForTest;
  const { handleIMessageApprovalReaction, registerIMessageApprovalReactionTarget } =
    await import("./approval-reactions.js");
  const { createIMessageDurableIngress } = await import("./monitor/ingress.js");
  type Queue = NonNullable<Parameters<typeof createIMessageDurableIngress>[0]["queue"]>;
  const queue = state.createChannelIngressQueueForTests<Parameters<Queue["enqueue"]>[1]>({
    channelId: "imessage",
    accountId: "default",
    stateDir: tempDirs.make("openclaw-imessage-ingress-replay-"),
  });
  // Hold redelivery open: released-pending has no stable backoff window.
  const { promise: secondAttemptGate, resolve: openSecondAttempt } = Promise.withResolvers<void>();
  resolveApproval
    .mockReset()
    .mockRejectedValueOnce(new Error("gateway 503"))
    .mockImplementationOnce(async () => {
      await secondAttemptGate;
      return {
        applied: true,
        approval: { status: "allowed", decision: "allow-once", reason: "user" },
      };
    });
  await registerIMessageApprovalReactionTarget({
    accountId: "default",
    conversation: { chatId: 7, handle: "+15551230000" },
    messageId: "pending-approval",
    approvalId: "approval-abc-123",
    approvalKind: "exec",
    allowedDecisions: ["allow-once", "deny"],
  });

  const chatLaneDispatch = vi.fn(async () => ({ kind: "completed" as const }));
  const monitor = createIMessageDurableIngress({
    accountId: "default",
    queue,
    // Match production: handled approvals complete; resolver errors reach the drain.
    dispatchPriority: async (message) => {
      const { handled } = await handleIMessageApprovalReaction({
        cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
        accountId: "default",
        message,
        bodyText: "",
      });
      return handled ? { kind: "completed" as const } : undefined;
    },
    dispatch: chatLaneDispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  monitor.start();
  const reactionRow: { message: IMessagePayload } = {
    message: {
      id: 42,
      guid: "guid-reaction-1",
      chat_id: 7,
      sender: "+15551230000",
      is_reaction: true,
      reaction_emoji: "👍",
      reacted_to_guid: "pending-approval",
    },
  };

  try {
    await monitor.receive(reactionRow);
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(2), { timeout: 15_000 });

    expect(chatLaneDispatch).not.toHaveBeenCalled();

    const [first, second] = resolveApproval.mock.calls;
    expect(second?.[0]).toEqual(first?.[0]);

    expect(await queue.listClaims()).toHaveLength(1);

    openSecondAttempt();
    await monitor.waitForIdle();
    expect(await queue.listPending({ limit: "all" })).toHaveLength(0);
    expect(await queue.listClaims()).toHaveLength(0);

    // The durable completion tombstone prevents a third dispatch.
    await monitor.receive(reactionRow);
    await monitor.waitForIdle();
    expect(resolveApproval).toHaveBeenCalledTimes(2);
  } finally {
    openSecondAttempt();
    await monitor.stop();
  }
});
