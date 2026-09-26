import type { JsonObject, JsonValue } from "../protocol.js";
import type { CodexSandboxExecMessageTransport, HttpHeader, JsonRpcRequest } from "./types.js";

/** JSON-RPC error code used when a sandbox filesystem resource does not exist. */
export const JSON_RPC_NOT_FOUND = -32004;

export const JSON_RPC_METHOD_NOT_FOUND = -32601;

export class JsonRpcProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseRequest(text: string): JsonRpcRequest {
  const parsed = JSON.parse(text) as unknown;
  return requireObject(parsed, "JSON-RPC request") as JsonRpcRequest;
}

export function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

/** Validates a base64 payload parameter as a string; decoding happens at call sites. */
export function requireBase64String(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return value;
}

export function readHttpHeaders(value: unknown): HttpHeader[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const record = requireObject(entry as JsonValue, `header ${index}`);
    return {
      name: requireString(record.name, "header name"),
      value: requireString(record.value, "header value"),
    };
  });
}

export function sendResult(
  send: CodexSandboxExecMessageTransport["send"],
  id: string | number,
  result: JsonValue,
): void {
  send({ jsonrpc: "2.0", id, result });
}

export function sendError(
  send: CodexSandboxExecMessageTransport["send"],
  id: string | number | undefined,
  code: number,
  message: string,
): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
