import { reuseCodexCatalogPreview } from "../session-catalog-native-projection.js";
import {
  recordCodexCatalogResponseSource,
  type CodexCatalogSource,
} from "../session-catalog-source.js";
import type {
  CodexCatalogDecodeResult,
  CodexClientRequestAttempt,
} from "./client-catalog-response.js";
import { isJsonObject, type RpcResponse } from "./protocol.js";
import { CODEX_APP_SERVER_OVERLOADED_ERROR_CODE, CodexAppServerRpcError } from "./rpc-error.js";

/** Settles one wire attempt and reports newly observed native execution. */
export function dispatchCodexAppServerResponse(
  response: RpcResponse,
  attempts: Map<number | string, CodexClientRequestAttempt>,
  source: CodexCatalogSource,
  preview?: CodexCatalogDecodeResult["preview"],
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
  const cache = pending.catalogProjection?.preview;
  if (cache && preview) {
    try {
      for (const [index, row] of preview.rows.entries()) {
        if (row.ephemeral !== true) {
          const cached = reuseCodexCatalogPreview(row, preview.states[index], cache);
          if (cached !== undefined) {
            row.preview = cached;
          }
        }
      }
    } catch (error) {
      pending.reject(
        error instanceof Error
          ? error
          : new Error("Codex catalog projection failed", { cause: error }),
        false,
      );
      return false;
    }
  }
  recordCodexCatalogResponseSource(pending.method, response.result, source);
  pending.resolve(response.result);
  return nativeExecution;
}
