/**
 * Test runtime factory for subagent announce delivery. It wires gateway,
 * session-store, queue, and hook behavior to caller-provided mocks.
 */
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway } from "../../../gateway/call.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import type { EmbeddedAgentQueueMessageOutcome } from "../../embedded-agent-runner/runs.js";

type DeliveryRuntimeMockOptions = {
  callGateway: (request: unknown) => Promise<unknown>;
  getRuntimeConfig: () => OpenClawConfig;
  loadSessionStore: (storePath: string) => unknown;
  resolveAgentIdFromSessionKey: (sessionKey: string) => string;
  resolveMainSessionKey: (cfg: unknown) => string;
  resolveSessionStorePathCore: (store: unknown, options: unknown) => string;
  isEmbeddedAgentRunActive: (sessionId: string) => boolean;
  queueEmbeddedAgentMessageWithOutcome: (
    sessionId: string,
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => EmbeddedAgentQueueMessageOutcome;
  hasHooks?: () => boolean;
};

function resolveExternalBestEffortDeliveryTarget(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
}) {
  return {
    deliver: Boolean(params.channel && params.to),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
  };
}

function resolveQueueSettings(params: {
  cfg?: {
    messages?: {
      queue?: {
        byChannel?: Record<string, string>;
      };
    };
  };
  channel?: string;
}) {
  return {
    mode:
      (params.channel && params.cfg?.messages?.queue?.byChannel?.[params.channel]) ?? "followup",
  };
}

/** Create a mocked announce delivery runtime for focused subagent tests. */
export function createSubagentAnnounceDeliveryRuntimeMock(options: DeliveryRuntimeMockOptions) {
  return {
    callGateway: (async <T = Record<string, unknown>>(request: Parameters<typeof callGateway>[0]) =>
      (await options.callGateway(request)) as T) as typeof callGateway,
    dispatchGatewayMethodInProcess: (async <T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown>,
      callOptions?: { expectFinal?: boolean; timeoutMs?: number },
    ) =>
      (await options.callGateway({
        method,
        params,
        expectFinal: callOptions?.expectFinal,
        timeoutMs: callOptions?.timeoutMs,
      })) as T) as typeof dispatchGatewayMethodInProcess,
    getRuntimeConfig: options.getRuntimeConfig,
    loadSessionEntry: (scope: { storePath?: string; sessionKey: string }) =>
      (options.loadSessionStore(scope.storePath ?? "") as Record<string, unknown>)[
        scope.sessionKey
      ],
    loadSessionStore: options.loadSessionStore,
    resolveAgentIdFromSessionKey: options.resolveAgentIdFromSessionKey,
    resolveMainSessionKey: options.resolveMainSessionKey,
    resolveSessionStorePathCore: options.resolveSessionStorePathCore,
    isEmbeddedAgentRunActive: options.isEmbeddedAgentRunActive,
    queueEmbeddedAgentMessageWithOutcome: options.queueEmbeddedAgentMessageWithOutcome,
    formatEmbeddedAgentQueueFailureSummary: (outcome: { reason?: string; sessionId?: string }) =>
      outcome.reason && outcome.sessionId
        ? `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=live`
        : undefined,
    getGlobalHookRunner: () => ({ hasHooks: () => options.hasHooks?.() ?? false }),
    createBoundDeliveryRouter: () => ({
      resolveDestination: () => ({ mode: "none" }),
    }),
    resolveConversationIdFromTargets: () => "",
    resolveExternalBestEffortDeliveryTarget,
    resolveQueueSettings,
  };
}

export type AgentCallRequest = {
  method?: string;
  params?: Record<string, unknown> & {
    message?: string;
    internalEvents?: Array<{ type?: string; taskLabel?: string; result?: string }>;
  };
};

export function visibleAgentResponse(runId = "run-main") {
  return {
    runId,
    status: "ok",
    result: {
      payloads: [{ text: "announced" }],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["announced"],
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSourceReplyPayloads: [{ text: "announced", sourceReplyFinal: true }],
    },
  };
}

export function expectInputProvenance(
  params: Record<string, unknown> | undefined,
  sourceSessionKey: string,
) {
  // Announce handoffs are inter-session messages; provenance lets the receiver
  // distinguish child-output delivery from ordinary user input.
  const inputProvenance = params?.inputProvenance;
  if (!inputProvenance || typeof inputProvenance !== "object") {
    throw new Error("Expected input provenance");
  }
  const provenance = inputProvenance as Record<string, unknown>;
  expect(provenance.kind).toBe("inter_session");
  expect(provenance.sourceSessionKey).toBe(sourceSessionKey);
  expect(provenance.sourceTool).toBe("subagent_announce");
}

export function expectAgentCallFields(
  call: AgentCallRequest,
  expected: {
    channel?: string;
    deliver?: boolean;
    sessionKey: string;
    to?: string;
  },
) {
  expect(call.method).toBe("agent");
  expect(call.params?.sessionKey).toBe(expected.sessionKey);
  expect(call.params?.deliver).toBe(expected.deliver);
  if ("channel" in expected) {
    expect(call.params?.channel).toBe(expected.channel);
  }
  if ("to" in expected) {
    expect(call.params?.to).toBe(expected.to);
  }
}
