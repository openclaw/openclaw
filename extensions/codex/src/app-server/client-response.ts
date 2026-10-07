import {
  reuseCodexCatalogPreview,
  type CodexCatalogPreviewCache,
} from "../session-catalog-native-projection.js";
import {
  recordCodexCatalogResponseSource,
  type CodexCatalogSource,
} from "../session-catalog-source.js";
import { isJsonObject, type RpcResponse } from "./protocol.js";
import type { CodexRequestAttempt } from "./request-attempt.js";
import { CODEX_APP_SERVER_OVERLOADED_ERROR_CODE, CodexAppServerRpcError } from "./rpc-error.js";

/** Settles one wire attempt and reports newly observed native execution. */
export function dispatchCodexAppServerResponse(
  response: RpcResponse,
  attempts: Map<number | string, CodexRequestAttempt>,
  catalogResponses: WeakMap<
    CodexRequestAttempt,
    { preview?: CodexCatalogPreviewCache; remainingRows?: number }
  >,
  source: CodexCatalogSource,
  previewStates?: (boolean | undefined)[],
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
  const cache = catalogResponses.get(pending)?.preview;
  if (
    cache &&
    previewStates &&
    isJsonObject(response.result) &&
    Array.isArray(response.result.data)
  ) {
    try {
      for (const [index, row] of response.result.data.entries()) {
        if (isJsonObject(row) && typeof row.id === "string" && row.ephemeral !== true) {
          const preview = reuseCodexCatalogPreview(
            {
              id: row.id,
              path: typeof row.path === "string" ? row.path : null,
              updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
              recencyAt: typeof row.recencyAt === "number" ? row.recencyAt : null,
            },
            previewStates[index],
            cache,
          );
          if (preview !== undefined) {
            row.preview = preview;
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
