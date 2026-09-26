import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { defaultRuntime } from "../../../runtime.js";
import type { EmbeddedAgentQueueMessageOutcome } from "../../embedded-agent-runner/runs.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

const requesterSessionKey = "agent:main:slack:channel:C123";
const origin = { channel: "slack", to: "channel:C123", accountId: "acct-1" };
const announcement = {
  requesterSessionKey,
  targetRequesterSessionKey: requesterSessionKey,
  triggerMessage: "child done",
  steerMessage: "child done",
  requesterSessionOrigin: origin,
  completionDirectOrigin: origin,
  directOrigin: origin,
  requesterIsSubagent: false,
  expectsCompletionMessage: true,
  bestEffortDeliver: true,
  directIdempotencyKey: "announce-diagnostics",
} satisfies Parameters<typeof deliverSubagentAnnouncement>[0];

function prepareDelivery(
  response: Record<string, unknown>,
  options: {
    config?: OpenClawConfig;
    activity?: { sessionId: string; isActive: boolean };
    onGatewayCall?: () => void;
  } = {},
) {
  const cfg = options.config ?? {};
  const activity = options.activity ?? { sessionId: "requester-session", isActive: false };
  const callGateway = vi.fn<typeof runtimeCallGateway>().mockImplementation(async (opts) => {
    options.onGatewayCall?.();
    opts.onAccepted?.({ status: "accepted" });
    return response;
  });
  const queueEmbeddedAgentMessageWithOutcome = vi.fn(
    (sessionId: string): EmbeddedAgentQueueMessageOutcome => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
      enqueuedAtMs: 4_100,
      deliveredAtMs: 4_200,
    }),
  );
  testing.setDepsForTest({
    callGateway: callGateway as typeof runtimeCallGateway,
    getRuntimeConfig: () => cfg,
    getRequesterSessionActivity: () => activity,
    resolveRequesterSessionAbandonment: () => undefined,
    loadRequesterSessionEntry: (sessionKey) => ({
      cfg,
      entry: undefined,
      canonicalKey: sessionKey,
      agentId: "main",
    }),
    queueEmbeddedAgentMessageWithOutcome,
  });
  return { callGateway, queueEmbeddedAgentMessageWithOutcome };
}

beforeEach(() => {
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
});

afterEach(() => {
  testing.setDepsForTest();
  vi.restoreAllMocks();
});

describe("subagent announcement delivery warnings", () => {
  it.each([
    {
      name: "ordinary subagent completion",
      sourceTool: "subagent_announce",
      sourceSessionKey: "agent:worker:subagent:child",
      sourceRunId: "run-child",
      expectedSource: "run run-child",
    },
    {
      name: "agent harness completion",
      sourceTool: "agent_harness_task",
      sourceSessionKey: "codex-native:child-thread",
      sourceRunId: undefined,
      expectedSource: "session codex-native:child-thread",
    },
  ])("logs a recovered direct failure for $name", async (testCase) => {
    const activity = { sessionId: "requester-session-recovered", isActive: false };
    const { callGateway, queueEmbeddedAgentMessageWithOutcome } = prepareDelivery(
      {
        result: {
          payloads: [],
          deliveryStatus: { status: "failed", errorMessage: "direct agent failed" },
        },
      },
      {
        activity,
        onGatewayCall: () => {
          activity.isActive = true;
        },
      },
    );

    const result = await deliverSubagentAnnouncement({
      ...announcement,
      sourceSessionKey: testCase.sourceSessionKey,
      sourceRunId: testCase.sourceRunId,
      sourceTool: testCase.sourceTool,
    });

    expect(result).toMatchObject({ delivered: true, path: "steered" });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.log).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      `[warn] Subagent completion direct announce failed for ${testCase.expectedSource}: direct agent failed; recovered via steered`,
    );
  });

  it.each([
    {
      name: "agent harness completion",
      sourceTool: "agent_harness_task",
      sourceSessionKey: "codex-native:failed-child-thread",
      sourceRunId: undefined,
      expectsCompletionMessage: true,
      requireDirectDelivery: false,
      expectedSource: "session codex-native:failed-child-thread",
    },
    {
      name: "legacy ordinary completion",
      sourceTool: "subagent_announce",
      sourceSessionKey: "agent:worker:subagent:legacy-child",
      sourceRunId: "run-legacy-child",
      expectsCompletionMessage: false,
      requireDirectDelivery: false,
      expectedSource: "run run-legacy-child",
    },
    {
      name: "requester settle wake",
      sourceTool: "subagent_settle",
      sourceSessionKey: "agent:worker:subagent:settled-child",
      sourceRunId: undefined,
      expectsCompletionMessage: false,
      requireDirectDelivery: true,
      expectedSource: undefined,
    },
  ])("preserves terminal direct-failure diagnostics for $name", async (testCase) => {
    const { callGateway, queueEmbeddedAgentMessageWithOutcome } = prepareDelivery({});
    callGateway.mockRejectedValue(new Error("gateway not connected"));

    const result = await deliverSubagentAnnouncement({
      ...announcement,
      sourceSessionKey: testCase.sourceSessionKey,
      sourceRunId: testCase.sourceRunId,
      sourceTool: testCase.sourceTool,
      expectsCompletionMessage: testCase.expectsCompletionMessage,
      requireDirectDelivery: testCase.requireDirectDelivery,
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      error: "gateway not connected",
    });
    expect(callGateway).toHaveBeenCalledTimes(4);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(defaultRuntime.log)
        .mock.calls.filter(([message]) =>
          String(message).startsWith("[warn] Subagent completion direct announce failed"),
        ),
    ).toEqual(
      testCase.expectedSource
        ? [
            [
              `[warn] Subagent completion direct announce failed for ${testCase.expectedSource}: gateway not connected`,
            ],
          ]
        : [],
    );
  });

  it.each([
    {
      name: "successful direct delivery",
      response: {
        result: {
          payloads: [{ text: "The subagent is done." }],
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["The subagent is done."],
        },
      },
      expected: { delivered: true, path: "direct" },
    },
    {
      name: "accepted completion handoff",
      response: { status: "accepted" },
      expected: { delivered: true, path: "direct" },
    },
    {
      name: "in-flight completion handoff",
      response: { status: "in_flight" },
      expected: { delivered: true, path: "direct" },
    },
    {
      name: "yielded completion handoff",
      response: { status: "ok", result: { payloads: [], meta: { yielded: true } } },
      expected: {
        delivered: false,
        path: "direct",
        reason: "completion_handoff_pending",
        disposition: "session_queued",
      },
    },
  ])("does not warn for $name", async ({ response, expected }) => {
    const { callGateway, queueEmbeddedAgentMessageWithOutcome } = prepareDelivery(response, {
      config: { messages: { groupChat: { visibleReplies: "message_tool" } } },
    });
    const result = await deliverSubagentAnnouncement({
      ...announcement,
      sourceTool: "subagent_announce",
      sourceSessionKey: "agent:worker:subagent:child",
      sourceRunId: "run-child",
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
    });

    expect(result).toMatchObject(expected);
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });
});
