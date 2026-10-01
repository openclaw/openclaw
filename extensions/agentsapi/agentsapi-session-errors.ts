import { APIConnectionError, APIError, APIUserAbortError } from "openai";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { AgentsApiError } from "./agentsapi-client.js";

export function isOptionalReadFailure(error: unknown, signal: AbortSignal): boolean {
  return (
    (signal.aborted && (error === signal.reason || error instanceof APIUserAbortError)) ||
    error instanceof APIConnectionError ||
    (error instanceof APIError && (error.status === 429 || (error.status ?? 0) >= 500))
  );
}

export function isTransportDisconnect(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AgentsApiError) {
    return false;
  }
  const code = asOptionalRecord(error)?.code;
  if (
    (typeof code === "string" &&
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(code)) ||
    (error instanceof TypeError && ["terminated", "fetch failed"].includes(error.message))
  ) {
    return true;
  }
  return error.cause instanceof Error && isTransportDisconnect(error.cause);
}
