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
