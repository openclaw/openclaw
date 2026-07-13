import type { ErrorShape, EventFrame, HelloOk } from "@openclaw/gateway-protocol";
export type GatewayProtocolSocket = {
  isOpen: () => boolean;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};
export type GatewayProtocolSocketHandlers = {
  open: () => void;
  message: (data: string) => void;
  close: (code: number, reason: string) => void;
  error: (error: Error) => void;
};
export type GatewayProtocolRequestOptions = {
  timeoutMs?: number | null;
  expectFinal?: boolean;
  onAccepted?: (payload: unknown) => void;
  signal?: AbortSignal;
};
type GatewayProtocolConnectContext<TPlan> = {
  generation: number;
  nonce: string | null;
  plan: TPlan;
};
export type GatewayProtocolCloseContext = {
  code: number;
  reason: string;
  generation: number;
  socketOpened: boolean;
  helloReceived: boolean;
  connectRequestSent: boolean;
  connectFailure?: { error: Error; reconnectDelayMs?: number };
};
type GatewayProtocolConnectDecision = {
  closeCode: number;
  closeReason: string;
  reconnectDelayMs?: number;
  stop?: boolean;
  error?: Error;
};
type GatewayProtocolCloseDecision = {
  retry: boolean;
  notify: boolean;
  reconnectDelayMs?: number;
  pendingError?: Error;
};
export type GatewayProtocolTiming<TPlan> = {
  phase:
    | "socket-open"
    | "challenge"
    | "fallback"
    | "device-identity-ready"
    | "connect-plan-ready"
    | "request-sent"
    | "hello"
    | "failed";
  generation: number;
  durationMs: number;
  phaseDurationMs: number;
  hasChallenge: boolean;
  usedFallback: boolean;
  plan?: TPlan;
  detail?: unknown;
};
export type GatewayProtocolRequestTiming = {
  id: string;
  method: string;
  ok: boolean;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  errorCode?: string;
};
export type GatewayProtocolClientOptions<TPlan> = {
  createSocket: (handlers: GatewayProtocolSocketHandlers) => GatewayProtocolSocket;
  createRequestId: () => string;
  createRequestError?: (error: Partial<ErrorShape>) => GatewayProtocolRequestError;
  createRequestTimeoutError?: (method: string, timeoutMs: number) => Error;
  createRequestAbortError?: (method: string) => Error;
  buildConnectPlan: (params: {
    nonce: string | null;
    generation: number;
  }) => TPlan | Promise<TPlan>;
  buildConnectParams: (plan: TPlan) => unknown;
  onConnectPlanError?: (error: Error) => GatewayProtocolConnectDecision;
  onConnectHello?: (hello: HelloOk, context: GatewayProtocolConnectContext<TPlan>) => void;
  onHello?: (hello: HelloOk) => void;
  onConnectFailure?: (
    error: GatewayProtocolRequestError,
    context: GatewayProtocolConnectContext<TPlan>,
  ) => GatewayProtocolConnectDecision;
  resolveClose: (context: GatewayProtocolCloseContext) => GatewayProtocolCloseDecision;
  onClose?: (context: GatewayProtocolCloseContext, decision: GatewayProtocolCloseDecision) => void;
  notifyStoppedClose?: boolean;
  onConnectError?: (error: Error) => void;
  onSocketFactoryError?: (error: Error) => void;
  onParseError?: (error: unknown) => void;
  onEvent?: (event: EventFrame) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onActivity?: () => void;
  onTiming?: (timing: GatewayProtocolTiming<TPlan>) => void;
  onRequestTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onCallbackError?: (label: string, error: unknown) => void;
  handshake:
    | { mode: "fallback"; timeoutMs: number }
    | {
        mode: "require-challenge";
        timeoutMs: number;
        timeoutMessage?: (elapsedMs: number) => string;
      };
  reconnect: { initialMs: number; multiplier: number; maxMs: number };
  requestTimeoutMs?: number;
  nowMs?: () => number;
  rethrowSocketFactoryError?: (error: Error) => boolean;
};
export class GatewayProtocolRequestError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;

  constructor(error: Partial<ErrorShape>) {
    super(error.message ?? "request failed");
    this.name = "GatewayProtocolRequestError";
    this.code = error.code ?? "UNAVAILABLE";
    this.details = error.details;
    this.retryable = error.retryable;
    this.retryAfterMs = error.retryAfterMs;
  }
}
