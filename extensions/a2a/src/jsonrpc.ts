/**
 * Lightweight JSON-RPC 2.0 implementation for A2A protocol.
 *
 * Handles request parsing, response formatting, error codes,
 * and optional batch support.  No external dependencies.
 */

// ── types ──────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
  [key: string]: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── standard error codes ───────────────────────────────────────────────

export const JSONRPC_ERROR = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
  TASK_NOT_FOUND: { code: -32001, message: "Task not found" },
  TASK_NOT_CANCELABLE: { code: -32002, message: "Task not cancelable" },
  PUSH_NOTIFICATION_NOT_SUPPORTED: {
    code: -32003,
    message: "Push Notification is not supported",
  },
  UNSUPPORTED_OPERATION: { code: -32004, message: "Unsupported operation" },
} as const;

// ── parse ──────────────────────────────────────────────────────────────

export function parseJsonRpc(
  body: string,
): JsonRpcRequest | JsonRpcRequest[] | JsonRpcError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return JSONRPC_ERROR.PARSE_ERROR;
  }

  if (Array.isArray(parsed)) {
    const requests: JsonRpcRequest[] = [];
    for (const item of parsed) {
      const req = validateRequest(item);
      if ("code" in req) return req; // batch error short-circuits
      requests.push(req);
    }
    return requests.length > 0 ? requests : JSONRPC_ERROR.INVALID_REQUEST;
  }

  return validateRequest(parsed);
}

function validateRequest(
  item: unknown,
): JsonRpcRequest | JsonRpcError {
  if (!item || typeof item !== "object") return JSONRPC_ERROR.INVALID_REQUEST;
  const r = item as Record<string, unknown>;
  if (r.jsonrpc !== "2.0") return JSONRPC_ERROR.INVALID_REQUEST;
  if (typeof r.method !== "string" || !r.method) return JSONRPC_ERROR.INVALID_REQUEST;
  return {
    jsonrpc: "2.0",
    id: r.id as string | number | null | undefined,
    method: r.method,
    params: r.params,
  };
}

// ── format ─────────────────────────────────────────────────────────────

export function formatResponse(
  id: string | number | null | undefined,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function formatError(
  id: string | number | null | undefined,
  error: JsonRpcError,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error };
}

export function formatJsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return formatError(id, { code, message, data });
}

// ── serialize ──────────────────────────────────────────────────────────

export function toJson(response: JsonRpcResponse | JsonRpcResponse[]): string {
  return JSON.stringify(response);
}

// ── notifications ──────────────────────────────────────────────────────

export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined || req.id === null;
}
