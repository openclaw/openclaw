import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { BackendApiError } from "./http-client.js";
import type { ApiKeyResolver } from "./key-resolver.js";

/** Map a thrown backend/transport error to a uniform tool error result. */
export function failure(api: OpenClawPluginApi, tool: string, userId: string, error: unknown) {
  if (error instanceof BackendApiError) {
    api.logger.warn(`[${tool.toUpperCase()}] backend error for ${userId}: ${error.message}`);
    return jsonResult({ success: false, error: `Backend request failed: ${error.message}` });
  }
  api.logger.error(`[${tool.toUpperCase()}] failed for ${userId}: ${String(error)}`);
  return jsonResult({ success: false, error: "Request to the backend failed; see gateway logs." });
}

/**
 * Resolve the per-uid API key, or return a ready-to-send tool error result.
 * Callers branch on `"error" in result`.
 */
export async function resolveKeyOrError(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
  userId: string,
  tool: string,
): Promise<{ apiKey: string } | { error: ReturnType<typeof jsonResult> }> {
  try {
    return { apiKey: await resolver.getApiKey(userId) };
  } catch (error) {
    api.logger.error(
      `[${tool.toUpperCase()}] key resolution failed for ${userId}: ${String(error)}`,
    );
    return {
      error: jsonResult({
        success: false,
        error:
          "Could not resolve an API key for this account; ask the operator to check leading-v2 config.",
      }),
    };
  }
}
