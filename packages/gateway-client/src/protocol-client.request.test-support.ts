import assert from "node:assert/strict";
import type { GatewayProtocolClientOptions } from "./protocol-client-contract.js";
import {
  GatewayProtocolClient,
  type GatewayProtocolRequestTiming,
  type GatewayProtocolSocketHandlers,
} from "./protocol-client.js";

export type RequestFrame = {
  id: string;
  method: string;
};

export type RequestConnection = {
  handlers: GatewayProtocolSocketHandlers;
  frames: RequestFrame[];
  close: (code?: number, reason?: string) => void;
};

export function createRequestHarness(options?: {
  createRequestId?: () => string;
  requestTimeoutMs?: number;
  onRequestTiming?: (this: unknown, timing: GatewayProtocolRequestTiming) => void;
  onCallbackError?: (label: string, error: unknown) => void;
  send?: (frame: RequestFrame) => void;
  nowMs?: () => number;
  createRequestError?: GatewayProtocolClientOptions<unknown>["createRequestError"];
}) {
  const connections: RequestConnection[] = [];
  let nextRequestId = 0;
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
      let open = true;
      const frames: RequestFrame[] = [];
      const close = (code = 1000, reason = "") => {
        open = false;
        handlers.close(code, reason);
      };
      connections.push({ handlers, frames, close });
      return {
        isOpen: () => open,
        send: (data) => {
          const frame = JSON.parse(data) as RequestFrame;
          frames.push(frame);
          options?.send?.(frame);
        },
        close,
      };
    },
    createRequestId: options?.createRequestId ?? (() => `request-${++nextRequestId}`),
    createRequestError: options?.createRequestError,
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
    requestTimeoutMs: options?.requestTimeoutMs,
    onRequestTiming: options?.onRequestTiming,
    onCallbackError: options?.onCallbackError,
    nowMs: options?.nowMs,
  });
  client.start();
  const connection = connections[0];
  assert(connection);
  return { client, connections, connection };
}

export function latestFrame(connection: RequestConnection): RequestFrame {
  const frame = connection.frames.at(-1);
  assert(frame);
  return frame;
}

export function respond(
  connection: RequestConnection,
  id: string,
  payload: unknown,
  ok = true,
): void {
  connection.handlers.message(
    JSON.stringify({
      type: "res",
      id,
      ok,
      ...(ok ? { payload } : { error: payload }),
    }),
  );
}

export function refuseBootstrapRead(
  connection: RequestConnection,
  id = latestFrame(connection).id,
): void {
  respond(
    connection,
    id,
    {
      code: "UNAVAILABLE",
      message: "suspended",
      retryable: true,
      retryAfterMs: 60_000,
      details: { reason: "gateway-suspending" },
    },
    false,
  );
}
