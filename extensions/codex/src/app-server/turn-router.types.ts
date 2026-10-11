import type { JsonValue, RpcRequest } from "./protocol.js";
export type CodexAppServerServerRequest = Required<Pick<RpcRequest, "id" | "method">> &
  Pick<RpcRequest, "params">;
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
