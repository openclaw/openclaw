import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

export type CodexNotificationCorrelation = {
  method: string;
  paramsKeys?: string[];
  activeThreadId: string;
  activeTurnId?: string;
  threadId?: string;
  turnId?: string;
  nestedTurnThreadId?: string;
  nestedTurnId?: string;
  turnStatus?: string;
  turnItemCount?: number;
  matchesActiveThread: boolean;
  matchesActiveTurn?: boolean;
};

export function isCodexNotificationForTurn(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    readCodexNotificationThreadId(value) === threadId &&
    readCodexNotificationTurnId(value) === turnId
  );
}

export function readCodexNotificationThreadId(record: JsonObject): string | undefined {
  return readNestedTurnThreadId(record) ?? readString(record, "threadId");
}

export function readCodexNotificationTurnId(record: JsonObject): string | undefined {
  return readNestedTurnId(record) ?? readString(record, "turnId");
}

export function describeCodexNotificationCorrelation(
  notification: CodexServerNotification,
  active: { threadId: string; turnId?: string },
): CodexNotificationCorrelation {
  const params = readJsonObject(notification, "params");
  const turn = params ? readJsonObject(params, "turn") : undefined;
  const threadId = params ? readString(params, "threadId") : undefined;
  const turnId = params ? readString(params, "turnId") : undefined;
  const nestedTurnThreadId = turn ? readString(turn, "threadId") : undefined;
  const nestedTurnId = turn ? readString(turn, "id") : undefined;
  const resolvedThreadId = params ? readCodexNotificationThreadId(params) : undefined;
  const resolvedTurnId = params ? readCodexNotificationTurnId(params) : undefined;
  const matchesActiveThread = resolvedThreadId === active.threadId;
  const matchesActiveTurn = active.turnId
    ? matchesActiveThread && resolvedTurnId === active.turnId
    : undefined;
  const items = turn ? readValue(turn, "items") : undefined;
  return {
    method: notification.method,
    ...(params ? { paramsKeys: readObjectKeys(params).toSorted() } : {}),
    activeThreadId: active.threadId,
    ...(active.turnId ? { activeTurnId: active.turnId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(nestedTurnThreadId ? { nestedTurnThreadId } : {}),
    ...(nestedTurnId ? { nestedTurnId } : {}),
    ...(turn ? { turnStatus: readString(turn, "status") } : {}),
    ...(Array.isArray(items) ? { turnItemCount: items.length } : {}),
    matchesActiveThread,
    ...(matchesActiveTurn === undefined ? {} : { matchesActiveTurn }),
  };
}

function readNestedTurnId(record: JsonObject): string | undefined {
  const turn = readJsonObject(record, "turn");
  return turn ? readString(turn, "id") : undefined;
}

function readNestedTurnThreadId(record: JsonObject): string | undefined {
  const turn = readJsonObject(record, "turn");
  return turn ? readString(turn, "threadId") : undefined;
}

function readJsonObject(
  record: JsonObject | CodexServerNotification,
  key: string,
): JsonObject | undefined {
  const value = readValue(record, key);
  return isJsonObject(value) ? value : undefined;
}

function readObjectKeys(record: JsonObject): string[] {
  try {
    return Object.keys(record);
  } catch {
    return [];
  }
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = readValue(record, key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readValue(record: JsonObject | CodexServerNotification, key: string): unknown {
  try {
    return (record as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
