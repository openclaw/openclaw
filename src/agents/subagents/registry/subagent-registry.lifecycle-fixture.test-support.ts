import type { SessionDeliveryState } from "../../../config/sessions/types.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";

export type LifecycleData = {
  phase?: string;
  startedAt?: number;
  endedAt?: number;
  aborted?: boolean;
  error?: string;
  stopReason?: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
  status?: string;
  timeoutPhase?: string;
  providerStarted?: boolean;
};
export type LifecycleEvent = Pick<AgentEventPayload, "runId"> &
  Partial<Omit<AgentEventPayload, "runId" | "data">> & { data?: LifecycleData };

export type SessionStoreEntry = {
  sessionId: string;
  updatedAt: number;
  delivery?: SessionDeliveryState;
};

type GatewayAgentRequestParams = {
  sessionKey?: string;
  idempotencyKey?: string;
  message?: string;
  inputProvenance?: {
    sourceSessionKey?: string;
  };
  internalEvents?: Array<{ status?: string; statusLabel?: string; result?: string }>;
};

export type GatewayRequest = Omit<CallGatewayOptions, "params"> & {
  params?: GatewayAgentRequestParams;
};

export function getAgentResultsForChildSession(
  requests: readonly GatewayRequest[],
  childSessionKey: string,
): string[] {
  return requests
    .filter((request) => {
      const inputProvenance = request.params?.inputProvenance;
      if (!inputProvenance || typeof inputProvenance !== "object") {
        return false;
      }
      return (
        (inputProvenance as { sourceSessionKey?: unknown }).sourceSessionKey === childSessionKey
      );
    })
    .flatMap((request) => {
      const internalEvents = request.params?.internalEvents;
      const event =
        Array.isArray(internalEvents) && internalEvents[0] && typeof internalEvents[0] === "object"
          ? (internalEvents[0] as { result?: string })
          : undefined;
      return typeof event?.result === "string" ? [event.result] : [];
    });
}
