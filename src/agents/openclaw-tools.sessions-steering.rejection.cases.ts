import { expect, it, vi } from "vitest";
import * as controllerSteer from "../sessions/session-controller.steer.js";
import {
  activeRun,
  withTestRequester,
  type SessionsSendSteeringFixtures,
} from "./openclaw-tools.sessions-steering.test-support.js";

export function registerSessionsSendRejectedSteeringTests({
  getSessionTool: createSessionTool,
  seedSession,
  callGatewayMock,
  mockGatewayResponses,
  settleContinuations,
  cloneTestConfig,
}: SessionsSendSteeringFixtures) {
  const getSessionTool: SessionsSendSteeringFixtures["getSessionTool"] = (name, options) =>
    withTestRequester(createSessionTool(name, options), options.agentSessionKey);

  it.each([
    {
      name: "runtime rejection",
      key: "agent:leasing-ops:cron:monthly-utility:run:run-fast",
      rejects: true,
      reason: "runtime_rejected",
    },
    {
      name: "captured automatic reply owner",
      key: "agent:leasing-ops:cron:monthly-utility:run:run-fast",
      deliveryMode: "automatic" as const,
      disposition: "steered" as const,
    },
    {
      name: "non-Cron run-looking key",
      key: "agent:leasing-ops:slack:channel:c-room:run:run-fast",
      streaming: false,
      disposition: "queued" as const,
    },
  ])(
    "sessions_send preserves the captured target for $name",
    async ({ key, rejects, deliveryMode, streaming, reason, disposition }) => {
      await seedSession("agent:re-portal:main");
      await seedSession(key, "caller-active-session");
      const queueMessage = await activeRun(key, {
        config: cloneTestConfig(),
        rejects,
        streaming,
        sourceReplyDeliveryMode: deliveryMode,
      });
      mockGatewayResponses({
        agent: { runId: "fallback-run", status: "accepted", acceptedAt: 2000 },
      });
      const result = await getSessionTool("sessions_send", {
        agentSessionKey: "agent:re-portal:main",
        agentChannel: "telegram",
        config: cloneTestConfig(),
      }).execute("active-send", {
        sessionKey: key,
        message: "[TASK-COMPLETE] occupancy ready",
        timeoutSeconds: 0,
      });
      expect(result.details).toMatchObject(
        disposition
          ? { status: "accepted", sessionKey: key, targetDisposition: disposition }
          : {
              status: "error",
              sessionKey: key,
              error: expect.stringContaining(`queue_message_failed reason=${reason}`),
            },
      );
      const admissions = callGatewayMock.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(admissions).toHaveLength(disposition === "queued" ? 1 : 0);
      if (disposition === "queued") {
        expect(result.details).toHaveProperty("runId", "fallback-run");
        expect(admissions[0]?.[0].params).toMatchObject({
          sessionKey: key,
          agentId: "leasing-ops",
          sourceReplyDeliveryMode: "message_tool_only",
        });
      }
      if (rejects) {
        expect(result.details).toHaveProperty(
          "error",
          expect.stringContaining("caller-active-session"),
        );
        expect(result.details).toHaveProperty(
          "error",
          expect.not.stringContaining("fallback_failed"),
        );
        const queuedText = queueMessage.mock.calls[0]?.[0];
        expect(queuedText).toContain("[Inter-session message]");
        expect(queuedText).toContain("[TASK-COMPLETE] occupancy ready");
        expect(queueMessage).toHaveBeenCalledWith(queuedText, {
          abortSignal: expect.any(AbortSignal),
          toolAuthorityFingerprint: expect.any(String),
          steeringMode: "all",
          isInboundUserReply: false,
          debounceMs: 0,
          deliveryTimeoutMs: undefined,
          waitForTranscriptCommit: true,
          onQueueAccepted: expect.any(Function),
          userTurnTranscriptRecorder: expect.any(Object),
        });
      } else if (disposition === "steered") {
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(queueMessage.mock.calls[0]?.[0]).toContain("[TASK-COMPLETE] occupancy ready");
        expect(queueMessage.mock.calls[0]?.[1]?.waitForTranscriptCommit).toBe(true);
        // Guidance joins the receiver's reply owner; it cannot impose a new output policy.
        expect(queueMessage.mock.calls[0]?.[1]).not.toHaveProperty("sourceReplyDeliveryMode");
      } else {
        expect(queueMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { reason: "injection_unavailable" as const, followup: true, mode: undefined },
    { reason: "not_running" as const, followup: true, mode: undefined },
    { reason: "no_active_run" as const, followup: true, mode: undefined },
    { reason: "stale_run" as const, followup: true, mode: undefined },
    { reason: "tool_authority_mismatch" as const, followup: true, mode: undefined },
    { reason: "requester_origin_mismatch" as const, followup: true, mode: undefined },
    { reason: "requester_origin_mismatch" as const, followup: false, mode: "steer" as const },
    { reason: "tool_authority_mismatch" as const, followup: false, mode: "steer" as const },
    { reason: "guarded_injection_unsupported" as const, followup: false, mode: undefined },
    { reason: "runtime_rejected" as const, followup: false, mode: undefined },
    { reason: "injection_unavailable" as const, followup: true, mode: "followup" as const },
    { reason: "injection_unavailable" as const, followup: false, mode: "steer" as const },
  ])(
    "sessions_send handles unaccepted eligible run-scoped steering: $reason, mode=$mode",
    async ({ reason, followup, mode }) => {
      const key = "agent:main:dashboard:sibling-rejection:run:captured";
      await seedSession(key, "sibling-rejection-session");
      await activeRun(key, { config: cloneTestConfig(), sessionId: "sibling-rejection-session" });
      const queue = vi
        .spyOn(controllerSteer, "steerSessionControllerOperation")
        .mockResolvedValueOnce({
          status: "rejected",
          reason,
        });
      mockGatewayResponses({
        agent: { runId: "sibling-followup", status: "accepted" },
        "agent.wait": { status: "ok", terminalReply: { disposition: "empty" } },
      });
      try {
        const result = await getSessionTool("sessions_send", {
          agentSessionKey: "agent:main:dashboard:sibling-sender",
        }).execute("unaccepted-sibling", {
          sessionKey: key,
          message: "synthetic update",
          timeoutSeconds: mode === "followup" ? undefined : 0,
          mode,
        });
        expect(result.details).toMatchObject(
          followup
            ? mode === "followup"
              ? { status: "no_reply" }
              : { status: "accepted", targetDisposition: "queued" }
            : { status: "error" },
        );
        const admissions = callGatewayMock.mock.calls.filter(
          ([request]) => request.method === "agent",
        );
        expect(admissions).toHaveLength(followup ? 1 : 0);
        if (followup) {
          expect(admissions[0]?.[0].params).toMatchObject({ sessionKey: key });
        }
        if (mode === "followup") {
          expect(queue).not.toHaveBeenCalled();
        } else {
          expect(queue).toHaveBeenCalledOnce();
          expect(queue).toHaveBeenCalledWith({
            operation: expect.objectContaining({ sessionId: "sibling-rejection-session" }),
            text: expect.stringContaining("synthetic update"),
            abortOnUnconfirmedTranscript: false,
            options: expect.objectContaining({
              assertCurrent: expect.any(Function),
              waitForTranscriptCommit: true,
            }),
          });
        }
      } finally {
        await settleContinuations();
        queue.mockRestore();
      }
    },
  );
}
