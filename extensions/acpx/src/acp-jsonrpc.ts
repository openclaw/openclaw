import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";

type JsonRpcId = string | number | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasValidId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isErrorObject(value: unknown): value is { code: number; message: string } {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.code === "number" &&
    Number.isFinite(record.code) &&
    typeof record.message === "string"
  );
}

function hasResultOrError(value: Record<string, unknown>): boolean {
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult && hasError) {
    return false;
  }
  if (!hasResult && !hasError) {
    return false;
  }
  if (hasError && !isErrorObject(value.error)) {
    return false;
  }
  return true;
}

export function isAcpJsonRpcMessage(value: unknown): value is AnyMessage {
  const record = asRecord(value);
  if (!record || record.jsonrpc !== "2.0") {
    return false;
  }

  const hasMethod = typeof record.method === "string" && record.method.length > 0;
  const hasId = Object.hasOwn(record, "id");

  if (hasMethod && !hasId) {
    // Notification
    return true;
  }

  if (hasMethod && hasId) {
    // Request
    return hasValidId(record.id);
  }

  if (!hasMethod && hasId) {
    // Response
    if (!hasValidId(record.id)) {
      return false;
    }
    return hasResultOrError(record);
  }

  return false;
}

export function isJsonRpcNotification(message: AnyMessage): boolean {
  return (
    Object.hasOwn(message, "method") &&
    typeof (message as { method?: unknown }).method === "string" &&
    !Object.hasOwn(message, "id")
  );
}

export function isSessionUpdateNotification(message: AnyMessage): boolean {
  return (
    isJsonRpcNotification(message) && (message as { method?: unknown }).method === "session/update"
  );
}

export function extractSessionUpdateNotification(
  message: AnyMessage,
): SessionNotification | undefined {
  if (!isSessionUpdateNotification(message)) {
    return undefined;
  }

  const params = asRecord((message as { params?: unknown }).params);
  if (!params) {
    return undefined;
  }

  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  if (!sessionId) {
    return undefined;
  }

  const update = asRecord(params.update);
  if (!update || typeof update.sessionUpdate !== "string") {
    return undefined;
  }

  return {
    sessionId,
    update: update as SessionNotification["update"],
  };
}

export function parsePromptStopReason(message: AnyMessage): string | undefined {
  if (!Object.hasOwn(message, "id") || !Object.hasOwn(message, "result")) {
    return undefined;
  }
  const record = asRecord((message as { result?: unknown }).result);
  if (!record) {
    return undefined;
  }
  return typeof record.stopReason === "string" ? record.stopReason : undefined;
}

export function parseJsonRpcErrorMessage(message: AnyMessage): string | undefined {
  if (!Object.hasOwn(message, "error")) {
    return undefined;
  }
  const errorRecord = asRecord((message as { error?: unknown }).error);
  if (!errorRecord || typeof errorRecord.message !== "string") {
    return undefined;
  }
  return errorRecord.message;
}
