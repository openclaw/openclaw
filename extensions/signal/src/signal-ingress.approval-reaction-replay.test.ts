import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { registerSignalApprovalReactionTarget } from "./approval-reactions.js";
// Real SQLite, monitor and handler; only Gateway approval resolution is mocked.
import { startSignalIngressMonitor } from "./signal-ingress.js";

const reactionStores = await vi.hoisted(() => import("./approval-reactions.test-support.js"));
const resolveApproval = vi.hoisted(() => vi.fn());

// mock-isolation: simulate approval failures without sending requests to a real Gateway.
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolveApproval,
}));

vi.useRealTimers();
const { createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
  await import("./monitor/event-handler.test-harness.js");
const { createSignalEventHandler } = await import("./monitor/event-handler.js");

type SignalIngressQueue = NonNullable<Parameters<typeof startSignalIngressMonitor>[0]["queue"]>;
type SignalIngressPayload = Parameters<SignalIngressQueue["enqueue"]>[1];

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

it(
  "replays approval reactions after a transient Gateway failure",
  { timeout: 30_000 },
  async () => {
    reactionStores.clearSignalApprovalReactionStoresForTest();
    const queue = createChannelIngressQueueForTests<SignalIngressPayload>({
      channelId: "signal",
      accountId: "default",
      stateDir: dirs.make("openclaw-signal-ingress-replay-"),
    });
    resolveApproval.mockRejectedValueOnce(new Error("gateway 503")).mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    await registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15550001111",
      messageId: "1700000000123",
      approvalId: "approval-abc-123",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
      targetAuthorKeys: ["+15550001111"],
      route: { deliveryMode: "session" },
    });

    const monitor = await startSignalIngressMonitor({
      accountId: "default",
      queue,
      dispatch: createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          cfg: {
            channels: { signal: { allowFrom: ["+15550001111"] } },
            approvals: { exec: { enabled: true, mode: "session" } },
          },
        }),
      ),
      runtime: { error: vi.fn(), log: vi.fn() },
    });
    const reactionEvent = createSignalReceiveEvent({
      reactionMessage: {
        emoji: "👍",
        targetAuthor: "+15550001111",
        targetSentTimestamp: 1700000000123,
      },
    });

    try {
      await monitor.receive(reactionEvent);
      await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await monitor.waitForIdle();

      // Retry backoff keeps the released row pending while we inspect it.
      expect(await queue.listClaims()).toHaveLength(0);
      expect(await queue.listPending({ limit: "all" })).toEqual([
        expect.objectContaining({ attempts: 1, lastError: expect.stringContaining("gateway 503") }),
      ]);

      await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(2), {
        timeout: 15_000,
      });
      await monitor.waitForIdle();

      const [first, replay] = resolveApproval.mock.calls;
      expect(replay?.[0]).toEqual(first?.[0]);
      expect(replay?.[0]).toMatchObject({
        approvalId: "approval-abc-123",
        approvalKind: "exec",
        decision: "allow-once",
        channel: "signal",
        accountId: "default",
      });

      expect(await queue.listPending({ limit: "all" })).toHaveLength(0);
      expect(await queue.listClaims()).toHaveLength(0);

      // The completion tombstone prevents a third dispatch.
      await monitor.receive(reactionEvent);
      await monitor.waitForIdle();
      expect(resolveApproval).toHaveBeenCalledTimes(2);
    } finally {
      await monitor.stop();
    }
  },
);
