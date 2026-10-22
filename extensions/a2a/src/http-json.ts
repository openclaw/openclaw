import type { ServerResponse } from "node:http";
import { sendJsonNoStore } from "openclaw/plugin-sdk/http-response-runtime";
import { A2A_JSON_RPC_ERROR_CODES, A2aProtocolError } from "./a2a-errors.js";

export type A2aRpcErrorObject = { code: number; message: string; data?: unknown };

/** Write a JSON body with `Cache-Control: no-store` (JSON-RPC responses). */
export function writeJsonResponse(res: ServerResponse, status: number, body: unknown): void {
  sendJsonNoStore(res, status, body);
}

/** Render any thrown error as a JSON-RPC `error` object. */
export function toRpcErrorObject(error: unknown): A2aRpcErrorObject {
  if (error instanceof A2aProtocolError) {
    const data = error.toErrorData();
    return {
      code: error.code,
      message: error.message,
      ...(data.length > 0 ? { data } : {}),
    };
  }
  return { code: A2A_JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message: "Internal error" };
}
