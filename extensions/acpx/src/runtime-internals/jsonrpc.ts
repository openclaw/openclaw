import { isRecord } from "./shared.js";

export type JsonRpcId = string | number | null;

function hasExclusiveResultOrError(value: Record<string, unknown>): boolean {
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  return hasResult !== hasError;
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function normalizeJsonRpcId(value: unknown): string | null {
  if (!isJsonRpcId(value) || value == null) {
    return null;
  }
  return String(value);
}

export function isAcpJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return false;
  }

  const hasMethod = typeof value.method === "string" && value.method.length > 0;
  const hasId = Object.hasOwn(value, "id");

  if (hasMethod && !hasId) {
    return true;
  }

  if (hasMethod && hasId) {
    return isJsonRpcId(value.id);
  }

  if (!hasMethod && hasId) {
    return isJsonRpcId(value.id) && hasExclusiveResultOrError(value);
  }

  return false;
}
