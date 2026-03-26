import { JsonRpcProtocolError } from "./errors.js";
import type { RequestId } from "./protocol.js";

export interface JsonRpcTraceContext {
  traceparent?: string | null;
  tracestate?: string | null;
}

export interface JsonRpcRequestEnvelope<M extends string = string, P = unknown> {
  id: RequestId;
  method: M;
  params?: P;
  trace?: JsonRpcTraceContext | null;
}

export interface JsonRpcNotificationEnvelope<M extends string = string, P = unknown> {
  method: M;
  params?: P;
}

export interface JsonRpcSuccessEnvelope<R = unknown> {
  id: RequestId;
  result: R;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorEnvelope {
  id: RequestId;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequestEnvelope
  | JsonRpcNotificationEnvelope
  | JsonRpcSuccessEnvelope
  | JsonRpcErrorEnvelope;

export function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "number" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

export function isJsonRpcRequestEnvelope(value: unknown): value is JsonRpcRequestEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    id?: unknown;
    method?: unknown;
  };

  return (
    isRequestId(candidate.id) &&
    typeof candidate.method === "string" &&
    !Object.prototype.hasOwnProperty.call(candidate, "result") &&
    !Object.prototype.hasOwnProperty.call(candidate, "error")
  );
}

export function isJsonRpcNotificationEnvelope(
  value: unknown,
): value is JsonRpcNotificationEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    method?: unknown;
    id?: unknown;
  };

  return typeof candidate.method === "string" && candidate.id === undefined;
}

export function isJsonRpcSuccessEnvelope(value: unknown): value is JsonRpcSuccessEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    id?: unknown;
  };

  return isRequestId(candidate.id) && Object.prototype.hasOwnProperty.call(candidate, "result");
}

export function isJsonRpcErrorEnvelope(value: unknown): value is JsonRpcErrorEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    id?: unknown;
    error?: unknown;
  };

  return isRequestId(candidate.id) && isJsonRpcErrorObject(candidate.error);
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return (
    isJsonRpcRequestEnvelope(value) ||
    isJsonRpcNotificationEnvelope(value) ||
    isJsonRpcSuccessEnvelope(value) ||
    isJsonRpcErrorEnvelope(value)
  );
}

export function assertJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!isJsonRpcMessage(value)) {
    throw new JsonRpcProtocolError(
      "Received a message that does not match the JSON-RPC envelope shape",
    );
  }

  return value;
}

export function toJsonRpcErrorObject(error: unknown): JsonRpcErrorObject {
  if (isJsonRpcErrorObject(error)) {
    return error;
  }

  if (error instanceof Error) {
    return {
      code: -32000,
      message: error.message,
      data: {
        name: error.name,
      },
    };
  }

  if (typeof error === "string") {
    return {
      code: -32000,
      message: error,
    };
  }

  return {
    code: -32000,
    message: "Unknown JSON-RPC error",
    data: error,
  };
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}
