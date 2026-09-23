export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

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

export function isRpcResponse(message: unknown): message is RpcResponse {
  return (
    message !== null &&
    typeof message === "object" &&
    "id" in message &&
    (typeof message.id === "number" || typeof message.id === "string") &&
    !("method" in message)
  );
}
