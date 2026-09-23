// Retention lifecycle for public completion announces: in_flight non-credit,
// same-key rejoin, successor fencing, and steer-fallback suppression.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import type { EmbeddedAgentQueueMessageOutcome } from "../../embedded-agent-runner/runs.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { deliverSlackChannelAnnouncement } from "./subagent-announce-delivery.slack-channel.test-support.js";
import { testing } from "./subagent-announce-delivery.test-support.js";

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;

function createGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async () => response) as unknown as typeof runtimeCallGateway;
}

function createSendMessageMock() {
  return vi.fn(async () => ({
    channel: "slack",
    to: "channel:C123",
    via: "direct" as const,
    mediaUrl: null,
    result: { messageId: "msg-1" },
  })) as unknown as typeof runtimeSendMessage;
}

function createQueueOutcomeMock(queued: boolean) {
  return vi.fn(async (): Promise<EmbeddedAgentQueueMessageOutcome> =>
    queued
      ? {
          queued: true as const,
          sessionId: "requester-session-channel",
          target: "embedded_run",
          gatewayHealth: "live",
          enqueuedAtMs: Date.now(),
          deliveredAtMs: Date.now(),
        }
      : {
          queued: false as const,
          sessionId: "requester-session-channel",
          reason: "no_active_run",
          gatewayHealth: "live",
        },
  );
}

beforeEach(() => {
  testing.clearRetainedCompletionHandoffKeysForTest();
});

afterEach(() => {
  testing.setDepsForTest();
  testing.clearRetainedCompletionHandoffKeysForTest();
  vi.restoreAllMocks();
});

describe("completion handoff retention lifecycle", () => {
  it("does not credit an in-flight completion announce replay as delivered", async () => {
    const directIdempotencyKey = "announce-channel-completion-inflight";
    const callGateway = createGatewayMock({
      runId: directIdempotencyKey,
      status: "in_flight",
      admissionPending: true,
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      directIdempotencyKey,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
      phases: [
        {
          phase: "direct-primary",
          delivered: false,
          path: "direct",
          reason: "completion_handoff_pending",
        },
      ],
    });
    expect(result.requesterVisibleFinalDelivered).toBeUndefined();
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not self-steer when a pending handoff becomes active between retries", async () => {
    const directIdempotencyKey = "announce-channel-completion-pending-rejoin";
    const callGateway = createGatewayMock({
      runId: directIdempotencyKey,
      status: "in_flight",
      admissionPending: true,
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    let attempt = 0;
    const requesterSessionActivity = () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          sessionId: "requester-session-channel",
          isActive: false,
        };
      }
      // Original handoff is now the active requester run (same idempotency/run id).
      return {
        sessionId: "requester-session-channel",
        runId: directIdempotencyKey,
        isActive: true,
      };
    };
    const params = {
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      requesterSessionActivity,
      directIdempotencyKey,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion rejoin",
      }),
    };

    const pending = await deliverSlackChannelAnnouncement(params);
    expect(pending).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();

    // Retry while the original handoff is still active: fence self-steer and
    // rejoin via same-key Gateway replay instead of enqueueing into itself.
    const stillPending = await deliverSlackChannelAnnouncement(params);
    expect(stillPending).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    vi.mocked(callGateway).mockResolvedValue({
      runId: directIdempotencyKey,
      status: "ok",
      result: {
        payloads: [{ text: "The delegated task is complete." }],
        deliveryStatus: sentDeliveryStatus,
      },
    });
    const delivered = await deliverSlackChannelAnnouncement(params);

    expect(delivered).toMatchObject({
      delivered: true,
      path: "direct",
      requesterVisibleFinalDelivered: true,
    });
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.map(
          (call) => (call[0] as { params?: Record<string, unknown> })?.params?.idempotencyKey,
        ),
    ).toEqual([directIdempotencyKey, directIdempotencyKey, directIdempotencyKey]);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("replays the original handoff after it settles even when a successor requester run is active", async () => {
    const directIdempotencyKey = "announce-channel-completion-successor-rejoin";
    const callGateway = createGatewayMock({
      runId: directIdempotencyKey,
      status: "in_flight",
      admissionPending: true,
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    let attempt = 0;
    const requesterSessionActivity = () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          sessionId: "requester-session-channel",
          isActive: false,
        };
      }
      // Original handoff A has settled; successor requester run B is active.
      // Identity checks no longer match A, but retained ownership must still
      // join Gateway replay instead of steering into B.
      return {
        sessionId: "requester-session-channel",
        runId: "successor-requester-run-b",
        isActive: true,
      };
    };
    const params = {
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      requesterSessionActivity,
      directIdempotencyKey,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion successor rejoin",
      }),
    };

    const pending = await deliverSlackChannelAnnouncement(params);
    expect(pending).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();

    vi.mocked(callGateway).mockResolvedValue({
      runId: directIdempotencyKey,
      status: "ok",
      result: {
        payloads: [{ text: "The delegated task is complete." }],
        deliveryStatus: sentDeliveryStatus,
      },
    });
    const delivered = await deliverSlackChannelAnnouncement(params);

    expect(delivered).toMatchObject({
      delivered: true,
      path: "direct",
      requesterVisibleFinalDelivered: true,
    });
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.map(
          (call) => (call[0] as { params?: Record<string, unknown> })?.params?.idempotencyKey,
        ),
    ).toEqual([directIdempotencyKey, directIdempotencyKey]);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("fences steer-fallback when retained handoff replay fails while a successor requester is active", async () => {
    const directIdempotencyKey = "announce-channel-completion-successor-replay-fail";
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        runId: directIdempotencyKey,
        status: "in_flight",
        admissionPending: true,
      })
      .mockRejectedValueOnce(
        new Error("original handoff replay failed"),
      ) as unknown as typeof runtimeCallGateway;
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    let attempt = 0;
    const requesterSessionActivity = () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          sessionId: "requester-session-channel",
          isActive: false,
        };
      }
      return {
        sessionId: "requester-session-channel",
        runId: "successor-requester-run-b",
        isActive: true,
      };
    };
    const params = {
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      requesterSessionActivity,
      directIdempotencyKey,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion successor replay fail",
      }),
    };

    const pending = await deliverSlackChannelAnnouncement(params);
    expect(pending).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    });
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();

    const failedReplay = await deliverSlackChannelAnnouncement(params);
    expect(failedReplay).toMatchObject({
      delivered: false,
      path: "direct",
      disposition: "retryable",
      terminal: true,
      error: "original handoff replay failed",
    });
    expect(failedReplay.phases?.some((phase) => phase.phase === "steer-fallback")).toBe(false);
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
