import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { callGateway } from "../gateway/call.js";
import type { EmbeddedPiQueueMessageOptions } from "./pi-embedded-runner/run-state.js";

type DeliveryRuntimeMockOptions = {
  callGateway: (request: unknown) => Promise<unknown>;
  getRuntimeConfig: () => OpenClawConfig;
  getSessionEntry: (params: { agentId: string; sessionKey: string }) => unknown;
  resolveAgentIdFromSessionKey: (sessionKey: string) => string;
  resolveMainSessionKey: (cfg: unknown) => string;
  isEmbeddedPiRunActive: (sessionId: string) => boolean;
  queueEmbeddedPiMessage: (
    sessionId: string,
    text: string,
    options?: EmbeddedPiQueueMessageOptions,
  ) => boolean;
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
    mode: (params.channel && params.cfg?.messages?.queue?.byChannel?.[params.channel]) ?? "none",
  };
}

export function createSubagentAnnounceDeliveryRuntimeMock(options: DeliveryRuntimeMockOptions) {
  return {
    callGateway: (async <T = Record<string, unknown>>(request: Parameters<typeof callGateway>[0]) =>
      (await options.callGateway(request)) as T) as typeof callGateway,
    getRuntimeConfig: options.getRuntimeConfig,
    getSessionEntry: options.getSessionEntry,
    resolveAgentIdFromSessionKey: options.resolveAgentIdFromSessionKey,
    resolveMainSessionKey: options.resolveMainSessionKey,
    isEmbeddedPiRunActive: options.isEmbeddedPiRunActive,
    queueEmbeddedPiMessage: options.queueEmbeddedPiMessage,
    isSteeringQueueMode: (mode: string) =>
      mode === "steer" || mode === "queue" || mode === "steer-backlog",
    resolvePiSteeringModeForQueueMode: (mode: string) =>
      mode === "queue" ? "one-at-a-time" : "all",
    getGlobalHookRunner: () => ({ hasHooks: () => options.hasHooks?.() ?? false }),
    createBoundDeliveryRouter: () => ({
      resolveDestination: () => ({ mode: "none" }),
    }),
    resolveConversationIdFromTargets: () => "",
    resolveExternalBestEffortDeliveryTarget,
    resolveQueueSettings,
  };
}
