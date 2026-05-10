/**
 * Leaf type module for the iMessage RPC client. Lives separate from
 * `client.ts` so helpers (e.g. `client-stdout-handler.ts`) can reference
 * the shared shapes without creating an import cycle through the runtime
 * client.
 */

export type IMessageRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type IMessageRpcResponse<T> = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: IMessageRpcError;
  method?: string;
  params?: unknown;
};

export type IMessageRpcNotification = {
  method: string;
  params?: unknown;
};
