import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import {
  selectCodexCatalogPreviewInput,
  truncateCodexCatalogPreview,
} from "../session-catalog-parsing.js";
import { isJsonObject, type RpcResponse } from "./protocol.js";
import type { CodexRequestAttempt } from "./request-attempt.js";
import { CODEX_APP_SERVER_OVERLOADED_ERROR_CODE, CodexAppServerRpcError } from "./rpc-error.js";

/** Settles one wire attempt and reports newly observed native execution. */
export function dispatchCodexAppServerResponse(
  response: RpcResponse,
  attempts: Map<number | string, CodexRequestAttempt>,
  catalogResponses: WeakSet<CodexRequestAttempt>,
): boolean {
  const pending = attempts.get(response.id);
  if (!pending) {
    return false;
  }
  attempts.delete(response.id);
  if (response.error) {
    const error = new CodexAppServerRpcError(response.error, pending.method);
    pending.reject(error, error.code === CODEX_APP_SERVER_OVERLOADED_ERROR_CODE);
    return false;
  }
  const nativeExecution =
    pending.method === "thread/backgroundTerminals/list" &&
    isJsonObject(response.result) &&
    Array.isArray(response.result.data) &&
    response.result.data.length > 0;
  if (
    catalogResponses.has(pending) &&
    isJsonObject(response.result) &&
    Array.isArray(response.result.data)
  ) {
    for (const thread of response.result.data) {
      if (isJsonObject(thread) && typeof thread.preview === "string") {
        thread.preview = truncateCodexCatalogPreview(
          selectCodexCatalogPreviewInput(thread.preview),
          sanitizeTerminalText,
        );
      }
    }
  }
  pending.resolve(response.result);
  return nativeExecution;
}
