/** Shared Slack-channel announcement delivery fixture for announce tests. */
import type { SessionEntry } from "../../../config/sessions.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import type {
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageOutcome,
} from "../../embedded-agent-runner/runs.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

type QueueEmbeddedAgentMessageWithOutcome = (
  sessionId: string,
  message: string,
  options?: EmbeddedAgentQueueMessageOptions,
) => EmbeddedAgentQueueMessageOutcome | Promise<EmbeddedAgentQueueMessageOutcome>;

export async function deliverSlackChannelAnnouncement(params: {
  callGateway: typeof runtimeCallGateway;
  isActive?: boolean;
  sessionId?: string;
  expectsCompletionMessage?: boolean;
  directIdempotencyKey: string;
  requesterSessionKey?: string;
  requesterOrigin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  completionDirectOrigin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  queueEmbeddedAgentMessageWithOutcome?: QueueEmbeddedAgentMessageWithOutcome;
  sendMessage?: typeof runtimeSendMessage;
  requesterSessionActivity?: () => {
    sessionId?: string;
    runId?: string;
    isActive: boolean;
  };
  internalEvents?: AgentInternalEvent[];
  sourceSessionKey?: string;
  sourceTool?: string;
  runtimeConfig?: Record<string, unknown>;
  requesterSessionEntry?: SessionEntry;
  isSourceSessionEffectsAllowed?: () => boolean;
}) {
  const origin = {
    channel: "slack",
    to: "channel:C123",
    accountId: "acct-1",
  } as const;
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity:
      params.requesterSessionActivity ??
      (() => ({
        sessionId: params.sessionId ?? "requester-session-channel",
        isActive: params.isActive === true,
      })),
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    ...(params.requesterSessionEntry
      ? {
          loadRequesterSessionEntry: (sessionKey: string) => ({
            cfg: (params.runtimeConfig ?? {}) as never,
            entry: params.requesterSessionEntry,
            canonicalKey: sessionKey,
          }),
        }
      : {}),
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedAgentMessageWithOutcome
      ? { queueEmbeddedAgentMessageWithOutcome: params.queueEmbeddedAgentMessageWithOutcome }
      : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey: params.requesterSessionKey ?? "agent:main:slack:channel:C123",
    targetRequesterSessionKey: params.requesterSessionKey ?? "agent:main:slack:channel:C123",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterSessionOrigin: params.requesterOrigin ?? origin,
    completionDirectOrigin: params.completionDirectOrigin ?? params.requesterOrigin ?? origin,
    directOrigin: params.requesterOrigin ?? origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: params.expectsCompletionMessage !== false,
    bestEffortDeliver: true,
    directIdempotencyKey: params.directIdempotencyKey,
    internalEvents: params.internalEvents,
    sourceRunId: "run-generated-media",
    sourceSessionKey: params.sourceSessionKey,
    sourceTool: params.sourceTool,
    isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
  });
}
