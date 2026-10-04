import type { JsonValue, RpcRequest } from "./protocol.js";
export type CodexAppServerServerRequest = Required<Pick<RpcRequest, "id" | "method">> & {
  params?: JsonValue;
};
export type CodexThreadRouteScope = {
  threadId: string;
  turnId?: string;
};
export type CodexThreadRequestHandler = (
  request: CodexAppServerServerRequest,
  scope: CodexThreadRouteScope,
  signal: AbortSignal,
  setExecutionTimeoutMs?: (timeoutMs: number) => void,
) => Promise<JsonValue | undefined> | JsonValue | undefined;
