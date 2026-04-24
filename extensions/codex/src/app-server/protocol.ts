import type {
  ServerNotification as GeneratedServerNotification,
  v2,
} from "./protocol-generated/typescript/index.js";
import type { JsonValue as GeneratedJsonValue } from "./protocol-generated/typescript/serde_json/JsonValue.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = GeneratedJsonValue;
export type JsonObject = { [key: string]: JsonValue };
export type CodexServiceTier = "fast" | "flex";

export type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
};

export type RpcResponse = {
  id: number | string;
  result?: JsonValue;
  error?: {
    code?: number;
    message: string;
    data?: JsonValue;
  };
};

export type RpcMessage = RpcRequest | RpcResponse;

export type CodexInitializeResponse = {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
};

export type CodexUserInput = v2.UserInput;

export type CodexDynamicToolSpec = v2.DynamicToolSpec;

export type CodexThreadStartParams = v2.ThreadStartParams & {
  dynamicTools?: CodexDynamicToolSpec[] | null;
};

export type CodexThreadResumeParams = v2.ThreadResumeParams;

export type CodexThreadStartResponse = v2.ThreadStartResponse;

export type CodexThreadResumeResponse = v2.ThreadResumeResponse;

export type CodexTurnStartParams = v2.TurnStartParams;

export type CodexTurnSteerParams = v2.TurnSteerParams;

export type CodexTurnInterruptParams = {
  threadId: string;
  turnId: string;
};

export type CodexTurnStartResponse = v2.TurnStartResponse;

export type CodexThread = v2.Thread;

export type CodexTurn = v2.Turn;

export type CodexThreadItem = v2.ThreadItem;

export type CodexKnownServerNotification = GeneratedServerNotification;
export type CodexServerNotification = {
  method: string;
  params?: JsonValue;
};

export type CodexDynamicToolCallParams = v2.DynamicToolCallParams;

export type CodexDynamicToolCallResponse = v2.DynamicToolCallResponse;

export type CodexDynamicToolCallOutputContentItem = v2.DynamicToolCallOutputContentItem;

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}

export function coerceJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}
